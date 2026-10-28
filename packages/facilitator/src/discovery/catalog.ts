/**
 * The Bazaar catalog (design §4.4), the public list of every provider's paid resources.
 *
 * Items are keyed by provider, canonical resource and method, and come from two sources. A provider's declaration is
 * validated whole and upserts its items, which is also its liveness signal. A settled payment bumps the matching item,
 * and lists a new one only for a provider that never declared, since the resource and extension of a payment are
 * echoed by the payer. All of it is synchronous and in memory, and when given a file the catalog writes it out after
 * a short delay (temp file, then rename), so a lost or corrupt file costs only the listing until the next heartbeat.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CatalogError,
  checkQuery,
  clampLimit,
  cursorOffset,
  keyOf,
  offsetOf,
  paymentFields,
  parseDeclaration,
  parseStore,
  readPayment,
  STORE_VERSION,
  type Accept,
  type CatalogProvider,
  type Declared,
  type Filters,
  type ListQuery,
  type SearchQuery,
  type Store,
  type Stored,
} from "./validate.js";

export {
  CatalogError,
  CatalogQueryError,
  parseListQuery,
  parseSearchQuery,
  type CatalogProvider,
  type ListQuery,
  type SearchQuery,
} from "./validate.js";

type Log = (msg: string, err?: unknown) => void;

const stderr: Log = (msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err));

export interface CatalogOptions {
  /** The catalog file, left out means a memory-only catalog */
  file?: string;
  /** The clock, which a test moves */
  now?: () => Date;
  /** Receives the diagnostics, which default to stderr */
  log?: Log;
  /** Items one provider may list, default 128 */
  maxPerProvider?: number;
  /** Items in all, default 4096 */
  maxTotal?: number;
  /** How long after a change the file is written, default 2000 */
  writeDelayMs?: number;
}

/** The standard DiscoveryResource, plus the liveness and paid calls the site shows */
export interface ServedResource {
  resource: string;
  type: "http";
  x402Version: 2;
  accepts: Accept[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
  lastSeen?: string;
  paidCallsToday: number;
}

export interface ListResult {
  x402Version: 2;
  items: ServedResource[];
  pagination: { limit: number; offset: number; total: number };
}

export interface SearchResult {
  x402Version: 2;
  resources: ServedResource[];
  partialResults: false;
  pagination: { limit: number; cursor: string | null };
}

const DEFAULT_MAX_PER_PROVIDER = 128;
const DEFAULT_MAX_TOTAL = 4096;
const DEFAULT_WRITE_DELAY_MS = 2000;
/** The longest delay setTimeout honours, past which Node fires it after 1 ms */
const MAX_TIMER_MS = 2_147_483_647;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function wholeNumber(name: string, value: number | undefined, min: number, max = Number.POSITIVE_INFINITY): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `of at least ${min}` : `from ${min} to ${max}`;
    throw new Error(`${name}: expected a whole number ${range}`);
  }
}

function checkOptions(o: CatalogOptions): void {
  if (o.file !== undefined && (typeof o.file !== "string" || o.file.trim() === "")) {
    throw new Error("file: must not be blank (leave it out for a memory-only catalog)");
  }
  wholeNumber("maxPerProvider", o.maxPerProvider, 1);
  wholeNumber("maxTotal", o.maxTotal, 1);
  wholeNumber("writeDelayMs", o.writeDelayMs, 0, MAX_TIMER_MS);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPosition = (a: Stored, b: Stored): number =>
  cmp(a.resource, b.resource) || cmp(a.method, b.method) || cmp(a.providerId, b.providerId);

const copyJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const isMissing = (e: unknown): boolean => typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";

/** The newest sign of life of an item, which is what the 7 days are counted from */
function newest(item: Stored): number {
  return Math.max(
    ...[item.firstListed, item.lastSeen, item.lastPaid].map((t) => (t === undefined ? 0 : Date.parse(t))),
  );
}

function count(item: Stored, at: string): void {
  const day = at.slice(0, 10);
  item.paidCount = item.paidDay === day ? item.paidCount + 1 : 1;
  item.paidDay = day;
  item.lastPaid = at;
}

function serve(item: Stored, day: string): ServedResource {
  return {
    resource: item.resource,
    type: "http",
    x402Version: 2,
    accepts: copyJson(item.accepts),
    lastUpdated: item.lastPaid ?? item.firstListed,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    ...(item.serviceName === undefined ? {} : { serviceName: item.serviceName }),
    ...(item.tags === undefined ? {} : { tags: [...item.tags] }),
    ...(item.iconUrl === undefined ? {} : { iconUrl: item.iconUrl }),
    ...(item.extensions === undefined ? {} : { extensions: copyJson(item.extensions) }),
    ...(item.lastSeen === undefined ? {} : { lastSeen: item.lastSeen }),
    paidCallsToday: item.paidDay === day ? item.paidCount : 0,
  };
}

function matches(item: Stored, f: Filters, needle: string | undefined): boolean {
  if (f.type !== undefined && f.type !== "http") return false;
  if (f.payTo !== undefined && !item.accepts.some((a) => a.payTo === f.payTo)) return false;
  if (f.scheme !== undefined && !item.accepts.some((a) => a.scheme === f.scheme)) return false;
  if (f.network !== undefined && !item.accepts.some((a) => a.network === f.network)) return false;
  // Own keys only, so that a name on Object.prototype never counts as carried
  if (f.extensions !== undefined && !(item.extensions !== undefined && Object.hasOwn(item.extensions, f.extensions))) {
    return false;
  }
  if (needle === undefined) return true;
  const haystack = [item.resource, item.description, item.serviceName, ...(item.tags ?? [])];
  return haystack.some((s) => s !== undefined && s.toLowerCase().includes(needle));
}

export class Catalog {
  readonly #file: string | undefined;
  readonly #now: () => Date;
  readonly #log: Log;
  readonly #maxPerProvider: number;
  readonly #maxTotal: number;
  readonly #writeDelayMs: number;
  readonly #items = new Map<string, Stored>();
  /** Providers that ever declared, whose payments therefore never create an item */
  readonly #declaring = new Set<string>();
  /** The caps already reported, so that a full catalog logs once and not on every heartbeat */
  readonly #warned = new Set<string>();
  #sorted: Stored[] | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #closed = false;

  private constructor(o: CatalogOptions) {
    this.#file = o.file;
    this.#now = o.now ?? (() => new Date());
    this.#log = o.log ?? stderr;
    this.#maxPerProvider = o.maxPerProvider ?? DEFAULT_MAX_PER_PROVIDER;
    this.#maxTotal = o.maxTotal ?? DEFAULT_MAX_TOTAL;
    this.#writeDelayMs = o.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS;
  }

  /** Reads the file when there is one, setting aside a file that cannot be used and starting empty */
  static load(o: CatalogOptions = {}): Catalog {
    checkOptions(o);
    const catalog = new Catalog(o);
    if (o.file !== undefined) catalog.#read(o.file);
    return catalog;
  }

  /** Upserts the declared items of a provider, all or none, and answers them as served */
  declare(p: CatalogProvider, body: unknown): ServedResource[] {
    const declared = parseDeclaration(p, body);
    this.#checkRoom(p, declared);
    const at = this.#now().toISOString();
    const touched = new Map<string, Stored>();
    for (const d of declared) {
      const key = keyOf(p.id, d.resource, d.method);
      const before = this.#items.get(key);
      const item: Stored = {
        ...d,
        providerId: p.id,
        source: "declared",
        firstListed: before?.firstListed ?? at,
        lastSeen: at,
        paidCount: before?.paidCount ?? 0,
      };
      if (before?.lastPaid !== undefined) item.lastPaid = before.lastPaid;
      if (before?.paidDay !== undefined) item.paidDay = before.paidDay;
      this.#items.set(key, item);
      touched.set(key, item);
    }
    this.#sorted = undefined;
    this.#declaring.add(p.id);
    this.#changed();
    const day = at.slice(0, 10);
    return [...touched.values()].map((item) => serve(item, day));
  }

  /** Counts a settled payment, and never throws, since a settle must not fail on the catalog */
  recordPaid(p: CatalogProvider, paymentPayload: unknown, paymentRequirements: unknown): void {
    try {
      this.#paid(p, paymentPayload, paymentRequirements);
    } catch (e) {
      this.#say("catalog: could not record a paid call", e);
    }
  }

  list(q: ListQuery): ListResult {
    const limit = clampLimit(q.limit);
    const offset = offsetOf(q.offset);
    const hits = this.#matching(q);
    const day = this.#today();
    return {
      x402Version: 2,
      items: hits.slice(offset, offset + limit).map((item) => serve(item, day)),
      pagination: { limit, offset, total: hits.length },
    };
  }

  search(q: SearchQuery): SearchResult {
    const needle = checkQuery(q.query).toLowerCase();
    const offset = cursorOffset(q.cursor);
    const limit = clampLimit(q.limit);
    const hits = this.#matching(q, needle);
    const page = hits.slice(offset, offset + limit);
    const next = offset + page.length;
    const day = this.#today();
    return {
      x402Version: 2,
      resources: page.map((item) => serve(item, day)),
      partialResults: false,
      pagination: { limit, cursor: next < hits.length ? String(next) : null },
    };
  }

  /** Writes any unwritten change now, and a failed write is logged and tried again at the next change or flush */
  flush(): Promise<void> {
    this.#cancel();
    this.#write();
    return Promise.resolve();
  }

  /** Flushes, and from then on changes stay in memory */
  close(): Promise<void> {
    this.#closed = true;
    return this.flush();
  }

  #paid(p: CatalogProvider, payload: unknown, requirements: unknown): void {
    const payment = readPayment(payload);
    if (payment === undefined) return;
    const key = keyOf(p.id, payment.resource, payment.method);
    const at = this.#now().toISOString();
    const found = this.#items.get(key);
    if (found !== undefined) {
      count(found, at);
      this.#changed();
      return;
    }
    // A provider that declared is listed by its declarations alone, however a payer echoes the resource
    if (this.#declaring.has(p.id)) return;
    const fields = paymentFields(p, requirements, payment);
    if (fields === undefined) return;
    const full = this.#full(...this.#counts(p));
    if (full !== undefined) {
      this.#warnOnce(p, full);
      return;
    }
    const day = at.slice(0, 10);
    this.#items.set(key, {
      ...fields,
      providerId: p.id,
      resource: payment.resource,
      method: payment.method,
      source: "payment",
      firstListed: at,
      lastPaid: at,
      paidDay: day,
      paidCount: 1,
    });
    this.#sorted = undefined;
    this.#changed();
  }

  #today(): string {
    return this.#now().toISOString().slice(0, 10);
  }

  #order(): Stored[] {
    return (this.#sorted ??= [...this.#items.values()].sort(byPosition));
  }

  #matching(f: Filters, needle?: string): Stored[] {
    return this.#order().filter((item) => matches(item, f, needle));
  }

  /** How many items this provider lists, and how many all providers do */
  #counts(p: CatalogProvider): [own: number, all: number] {
    return [[...this.#items.values()].filter((item) => item.providerId === p.id).length, this.#items.size];
  }

  /** Which cap one more item of this provider would break, if any */
  #full(own: number, all: number): "provider" | "total" | undefined {
    if (own >= this.#maxPerProvider) return "provider";
    return all >= this.#maxTotal ? "total" : undefined;
  }

  /** Refuses a declaration whose new items do not fit, naming the first that does not */
  #checkRoom(p: CatalogProvider, declared: Declared[]): void {
    let [own, all] = this.#counts(p);
    const added = new Set<string>();
    for (const [index, d] of declared.entries()) {
      const key = keyOf(p.id, d.resource, d.method);
      if (this.#items.has(key) || added.has(key)) continue;
      added.add(key);
      const full = this.#full(own, all);
      if (full !== undefined) {
        this.#warnOnce(p, full);
        const lists =
          full === "provider"
            ? `this provider already lists ${this.#maxPerProvider}`
            : `the catalog already lists ${this.#maxTotal}`;
        throw new CatalogError(`items[${index}]: ${lists} resources`, index);
      }
      own++;
      all++;
    }
  }

  #warnOnce(p: CatalogProvider, cap: "provider" | "total"): void {
    const scope = cap === "provider" ? `provider ${p.id}` : "total";
    if (this.#warned.has(scope)) return;
    this.#warned.add(scope);
    this.#say(
      cap === "provider"
        ? `catalog: provider ${p.id} is at its limit of ${this.#maxPerProvider} items, so new items are not listed`
        : `catalog: the catalog is at its limit of ${this.#maxTotal} items, so new items are not listed`,
    );
  }

  /** A logger that throws must not break a declaration or a settle */
  #say(msg: string, err?: unknown): void {
    try {
      this.#log(msg, err);
    } catch {}
  }

  /* The file */

  #read(file: string): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if (!isMissing(e)) this.#setAside(file, e);
      return;
    }
    let store: Store;
    try {
      store = parseStore(JSON.parse(text));
    } catch (e) {
      this.#setAside(file, e);
      return;
    }
    const cutoff = this.#now().getTime() - KEEP_MS;
    for (const item of store.items) {
      if (newest(item) >= cutoff) this.#items.set(keyOf(item.providerId, item.resource, item.method), item);
    }
    for (const id of store.declared) this.#declaring.add(id);
  }

  #setAside(file: string, cause: unknown): void {
    const aside = `${file}.bad-${this.#now().getTime()}`;
    let fate = `was set aside as ${aside}`;
    try {
      renameSync(file, aside);
    } catch {
      fate = "could not be set aside";
    }
    this.#say(`catalog: ${file} is unreadable or invalid and ${fate}, starting empty`, cause);
  }

  #changed(): void {
    this.#dirty = true;
    // The timer is not restarted by later changes, so a steady stream cannot postpone the write for ever
    if (this.#file === undefined || this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#write();
    }, this.#writeDelayMs);
    this.#timer.unref();
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #write(): void {
    const file = this.#file;
    if (file === undefined || !this.#dirty) return;
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const store = { version: STORE_VERSION, declared: [...this.#declaring].sort(), items: this.#order() };
      // Exclusive create, so a leftover file of the same name is never written through
      writeFileSync(temp, JSON.stringify(store), { flag: "wx", mode: 0o600 });
      renameSync(temp, file);
      this.#dirty = false;
    } catch (e) {
      try {
        unlinkSync(temp);
      } catch {}
      this.#say(`catalog: could not write ${file}`, e);
    }
  }
}
