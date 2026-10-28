/**
 * The Bazaar catalog (design §4.4), the public list of every provider's paid resources.
 *
 * Items are keyed by provider, canonical resource and method, and come from two sources. A provider's declaration is
 * validated whole and upserts its items, which is also its liveness signal. A settled payment bumps the matching item,
 * and lists a new one only for a provider that has never declared, since the resource and extension of a payment are
 * echoed by the payer. That item holds the URL, the terms the server verified, the bazaar extension and the mimeType,
 * and a provider has at most a few of them. A provider's first declaration removes the payment-sourced items it does
 * not declare itself, and is written to the file before declare returns, so that a crash cannot reopen a declaring
 * provider to payment listings. Every other change is written after a short delay (temp file, fsync, rename). If the
 * file is lost, a provider can be listed from payments only until its next declaration, which removes those items.
 *
 * The items together take at most a byte budget, counted as the JSON of each stored item. A declaration that would pass
 * it is refused whole, a payment that would pass it lists nothing, and a file that holds more drops its oldest items.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  /** Items one provider may have that its payments listed, default 8 */
  maxPaymentItemsPerProvider?: number;
  /** The bytes the stored items may take as JSON, default 16 MiB */
  maxBytes?: number;
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
const DEFAULT_MAX_PAYMENT_ITEMS_PER_PROVIDER = 8;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
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
  wholeNumber("maxPaymentItemsPerProvider", o.maxPaymentItemsPerProvider, 1);
  wholeNumber("maxBytes", o.maxBytes, 1);
  wholeNumber("writeDelayMs", o.writeDelayMs, 0, MAX_TIMER_MS);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPosition = (a: Stored, b: Stored): number =>
  cmp(a.resource, b.resource) || cmp(a.method, b.method) || cmp(a.providerId, b.providerId);

const copyJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const byteSize = (item: Stored): number => Buffer.byteLength(JSON.stringify(item), "utf8");

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
  readonly #maxPaymentItemsPerProvider: number;
  readonly #maxBytes: number;
  readonly #writeDelayMs: number;
  readonly #items = new Map<string, Stored>();
  /** The JSON size of each stored item, and their sum, which the byte budget counts */
  readonly #sizes = new Map<string, number>();
  #bytes = 0;
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
    this.#maxPaymentItemsPerProvider = o.maxPaymentItemsPerProvider ?? DEFAULT_MAX_PAYMENT_ITEMS_PER_PROVIDER;
    this.#maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
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
    const entering = !this.#declaring.has(p.id);
    // A provider that enters the declaring set loses the payment-sourced items it does not declare itself
    const dropped = entering ? this.#unclaimed(p, declared) : [];
    this.#checkRoom(p, declared, dropped.length);
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
      touched.set(key, item);
    }
    this.#checkBytes(p, touched, dropped);
    for (const key of dropped) this.#forget(key);
    for (const [key, item] of touched) this.#store(key, item);
    this.#sorted = undefined;
    this.#declaring.add(p.id);
    this.#changed();
    // The flag and the removals are on disk before the answer, since a crash would reopen the provider to payments
    if (entering && !this.#closed) this.#write();
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
      // Never refused, since the count adds a few bytes at most and a settle has already happened
      this.#store(key, found);
      this.#changed();
      return;
    }
    // A provider that declared is listed by its declarations alone, however a payer echoes the resource
    if (this.#declaring.has(p.id)) return;
    const fields = paymentFields(p, requirements, payment);
    if (fields === undefined) return;
    if (this.#paymentItems(p) >= this.#maxPaymentItemsPerProvider) {
      this.#warnOnce(p, "payments");
      return;
    }
    const full = this.#full(...this.#counts(p));
    if (full !== undefined) {
      this.#warnOnce(p, full);
      return;
    }
    const created: Stored = {
      ...fields,
      providerId: p.id,
      resource: payment.resource,
      method: payment.method,
      source: "payment",
      firstListed: at,
      lastPaid: at,
      paidDay: at.slice(0, 10),
      paidCount: 1,
    };
    if (this.#bytes + byteSize(created) > this.#maxBytes) {
      this.#warnOnce(p, "bytes");
      return;
    }
    this.#store(key, created);
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

  /** How many items of this provider were listed by its payments */
  #paymentItems(p: CatalogProvider): number {
    let n = 0;
    for (const item of this.#items.values()) if (item.providerId === p.id && item.source === "payment") n++;
    return n;
  }

  /** Keeps an item under its key, counting its bytes in place of the ones of the item it replaces */
  #store(key: string, item: Stored): void {
    const bytes = byteSize(item);
    this.#bytes += bytes - (this.#sizes.get(key) ?? 0);
    this.#sizes.set(key, bytes);
    this.#items.set(key, item);
  }

  #forget(key: string): void {
    this.#bytes -= this.#sizes.get(key) ?? 0;
    this.#sizes.delete(key);
    this.#items.delete(key);
  }

  /** Refuses a declaration that would grow the stored items past the byte budget, whole */
  #checkBytes(p: CatalogProvider, next: Map<string, Stored>, dropped: string[]): void {
    let growth = 0;
    for (const [key, item] of next) growth += byteSize(item) - (this.#sizes.get(key) ?? 0);
    for (const key of dropped) growth -= this.#sizes.get(key) ?? 0;
    // A declaration that does not grow the items passes, so that a catalog at its budget still takes heartbeats
    if (growth <= 0 || this.#bytes + growth <= this.#maxBytes) return;
    this.#warnOnce(p, "bytes");
    throw new CatalogError("the catalog is full");
  }

  /** Which cap one more item of this provider would break, if any */
  #full(own: number, all: number): "provider" | "total" | undefined {
    if (own >= this.#maxPerProvider) return "provider";
    return all >= this.#maxTotal ? "total" : undefined;
  }

  /** The keys of this provider's payment-sourced items that a declaration does not declare itself */
  #unclaimed(p: CatalogProvider, declared: Declared[]): string[] {
    const claimed = new Set(declared.map((d) => keyOf(p.id, d.resource, d.method)));
    const keys: string[] = [];
    for (const [key, item] of this.#items) {
      if (item.providerId === p.id && item.source === "payment" && !claimed.has(key)) keys.push(key);
    }
    return keys;
  }

  /** Refuses a declaration whose new items do not fit once `freed` items are gone, naming the first that does not */
  #checkRoom(p: CatalogProvider, declared: Declared[], freed: number): void {
    const [listed, total] = this.#counts(p);
    let own = listed - freed;
    let all = total - freed;
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

  #warnOnce(p: CatalogProvider, cap: "provider" | "total" | "payments" | "bytes"): void {
    const scope = cap === "total" || cap === "bytes" ? cap : `${cap} ${p.id}`;
    if (this.#warned.has(scope)) return;
    this.#warned.add(scope);
    const limit = {
      provider: `provider ${p.id} is at its limit of ${this.#maxPerProvider} items, so new items are not listed`,
      payments:
        `provider ${p.id} is at its limit of ${this.#maxPaymentItemsPerProvider} items listed from payments, ` +
        "so new ones are not listed",
      total: `the catalog is at its limit of ${this.#maxTotal} items, so new items are not listed`,
      bytes: `the catalog is at its limit of ${this.#maxBytes} bytes, so new items are not listed`,
    }[cap];
    this.#say(`catalog: ${limit}`);
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
      if (newest(item) >= cutoff) this.#store(keyOf(item.providerId, item.resource, item.method), item);
    }
    for (const id of store.declared) this.#declaring.add(id);
    this.#fit(file);
  }

  /** Drops the oldest items until the rest fit the byte budget, and says so once */
  #fit(file: string): void {
    if (this.#bytes <= this.#maxBytes) return;
    const oldest = [...this.#items].sort(([ka, a], [kb, b]) => newest(a) - newest(b) || cmp(ka, kb));
    let dropped = 0;
    for (const [key] of oldest) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#forget(key);
      dropped++;
    }
    this.#say(`catalog: ${file} holds more than ${this.#maxBytes} bytes, so its ${dropped} oldest items were dropped`);
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
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(store));
        // On disk before the rename, so that a power loss cannot leave the name pointing at an empty file
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
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
