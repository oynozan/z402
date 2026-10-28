/**
 * The discover subcommand. It lists what a Bazaar endpoint knows with the stock client, withBazaar over an
 * HTTPFacilitatorClient, the way any agent would without z402 code. With --intent the list is ranked here by word
 * overlap, so the service never learns what an agent wants.
 *
 * The endpoint is not trusted. A run has one deadline and one byte budget for all its requests, reads at most 1,000
 * entries in at most 100 pages, refuses an entry that nests too deeply to print, and shows no character a terminal acts on.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar, type DiscoveryResource } from "@x402/extensions/bazaar";
import { ASSET } from "@z402-net/protocol";
import { DISCOVER_USAGE, FlagError, parseDiscoverFlags, type DiscoverFlags } from "./flags.js";
import { formatZat } from "./log.js";

export class DiscoverError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoverError";
  }
}

export interface DiscoverIo {
  print: (line: string) => void;
  /** Errors and notes, so that print carries the list and nothing else */
  warn: (line: string) => void;
}

export interface DiscoverLimits {
  /** How long the whole run may take, every page included, default 60000 */
  timeoutMs?: number;
  /** How many bytes all the answers together may hold, default 32 MiB */
  maxBytes?: number;
}

/** One entry of the list, of which only the URL is certain. The z402 facilitator adds lastSeen and paidCallsToday */
export type Listed = Partial<DiscoveryResource> & { resource: string; lastSeen?: string; paidCallsToday?: number };

const LIST_PATH = "/discovery/resources";
/** Where a longer list is cut */
const MAX_RESOURCES = 1000;
/** So that a service that sends one new entry per page cannot keep the command asking */
const MAX_PAGES = 100;
/** Far more than any declaration needs, and far less than the depth at which JSON.stringify gives up on an indent */
const MAX_DEPTH = 64;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const EXCERPT_CHARS = 120;
const MIN_WORD_CHARS = 3;
/** The most characters a cell of the list shows, so that one long text cannot widen the column of every row */
const CELL_CHARS = { name: 48, method: 16, url: 300, price: 64, description: 240 } as const;
/** The z402 facilitator's own reading of lastSeen: up under 90 s, stale under 10 min, down after */
const UP_MS = 90_000;
const STALE_MS = 600_000;
/** Digits only, and short: formatZat takes time that grows with the square of a run of digits */
const AMOUNT_RE = /^[0-9]{1,40}$/;
/** Format characters (bidi overrides, zero-width spaces, tags) except the joiners that emoji and some scripts need */
const INVISIBLE_RE = /(?![\u200c\u200d])\p{Cf}/gu;
const CONTROL_RUN_RE = /[\p{Cc}\s]+/gu;
/** What JSON.stringify leaves as it is and a terminal can act on: DEL, C1 controls, format characters, line separators */
const UNSAFE_JSON_RE = /[\u007f-\u009f\p{Cf}\u2028\u2029]/gu;

/* Reading what the service sent */

/** Reads a nested field of parsed JSON, undefined at the first step that is missing */
function at(value: unknown, ...path: string[]): unknown {
  let node = value;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
}

const methodOf = (item: Listed): unknown => at(item, "extensions", "bazaar", "info", "input", "method");

/** One line, so that a newline, a terminal escape or a text-direction override in the service's text cannot bend the list */
function oneLine(text: string): string {
  return text.replace(INVISIBLE_RE, "").replace(CONTROL_RUN_RE, " ").trim();
}

/** At most `max` characters, counted in code points, ending in an ellipsis when it was cut */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept: string[] = [];
  let count = 0;
  for (const point of text) {
    if (++count > max) return `${kept.slice(0, max - 1).join("")}…`;
    kept.push(point);
  }
  return text;
}

function excerpt(text: string): string {
  return clip(oneLine(text), EXCERPT_CHARS);
}

/** Whether `value` nests objects or arrays deeper than `max`, found level by level so that a hostile one cannot overflow us */
function nestsDeeperThan(value: unknown, max: number): boolean {
  let level: unknown[] = [value];
  for (let depth = 1; level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (typeof node !== "object" || node === null) continue;
      if (depth > max) return true;
      for (const child of Array.isArray(node) ? node : Object.values(node)) next.push(child);
    }
    level = next;
  }
  return false;
}

/* The list lines */

interface Row {
  name: string;
  method: string;
  url: string;
  price: string;
  activity: string;
  description: string;
}

function priceOf(item: Listed): string {
  const amount = at(item, "accepts", "0", "amount");
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) return "-";
  const asset = str(at(item, "accepts", "0", "asset"));
  const price = asset === ASSET ? `${formatZat(amount)} zat` : `${amount} ${asset ?? ""}`;
  const unit = oneLine(str(at(item, "extensions", "z402", "unit")) ?? "");
  return unit === "" ? price : `${price} per ${unit}`;
}

/** Liveness and today's paid calls, empty when the list carries neither */
function activityOf(item: Listed, now: number): string {
  const parts: string[] = [];
  const seen = at(item, "lastSeen");
  const seenAt = typeof seen === "string" ? Date.parse(seen) : Number.NaN;
  if (Number.isFinite(seenAt)) {
    const age = now - seenAt;
    parts.push(age < UP_MS ? "up" : age < STALE_MS ? "stale" : "down");
  }
  const paid = at(item, "paidCallsToday");
  if (typeof paid === "number" && Number.isSafeInteger(paid) && paid >= 0) parts.push(`${formatZat(String(paid))} paid today`);
  return parts.join(", ");
}

function rowOf(item: Listed, now: number): Row {
  const cell = (value: unknown, max: number): string => clip(oneLine(str(value) ?? ""), max) || "-";
  return {
    name: cell(item.serviceName, CELL_CHARS.name),
    method: cell(methodOf(item), CELL_CHARS.method),
    url: cell(item.resource, CELL_CHARS.url),
    price: clip(oneLine(priceOf(item)), CELL_CHARS.price),
    activity: activityOf(item, now),
    description: clip(oneLine(str(item.description) ?? ""), CELL_CHARS.description),
  };
}

/** One aligned line per resource with its service, method, URL, price and unit, its activity when listed, then the description */
export function listLines(items: readonly Listed[], now: number = Date.now()): string[] {
  const rows = items.map((item) => rowOf(item, now));
  const active = rows.some((r) => r.activity !== "");
  const widest = (cell: (row: Row) => string): number => rows.reduce((n, row) => Math.max(n, cell(row).length), 0);
  const width = {
    name: widest((r) => r.name),
    method: widest((r) => r.method),
    url: widest((r) => r.url),
    price: widest((r) => r.price),
    activity: widest((r) => r.activity || "-"),
  };
  return rows.map((r) =>
    [
      r.name.padEnd(width.name),
      r.method.padEnd(width.method),
      r.url.padEnd(width.url),
      r.price.padEnd(width.price),
      ...(active ? [(r.activity || "-").padEnd(width.activity)] : []),
      r.description,
    ]
      .join("  ")
      .trimEnd(),
  );
}

/** JSON text that parses to the same thing, with no raw character that a terminal acts on */
function printableJson(json: string): string {
  const escape = (chars: string): string =>
    Array.from({ length: chars.length }, (_, i) => `\\u${chars.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
  return json.replace(UNSAFE_JSON_RE, escape);
}

/* Ranking by intent */

const STOPWORDS = new Set(
  (
    "the and for with from that this these those into over are was were been has have had can will would should " +
    "could not but any all our your its their then than who what when where which why how per via one also just " +
    "some want need like please"
  ).split(" "),
);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .filter((word) => word.length >= MIN_WORD_CHARS && !STOPWORDS.has(word));
}

/** The property names a resource says its call takes, not the schema keywords around them */
function inputNames(item: Listed): string[] {
  return ["queryParams", "body", "pathParams"].flatMap((part) =>
    keysOf(at(item, "extensions", "bazaar", "schema", "properties", "input", "properties", part, "properties")),
  );
}

function wordsOfResource(item: Listed): Set<string> {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const unit = at(item, "extensions", "z402", "unit");
  const texts = [item.serviceName, item.description, ...tags, unit, ...inputNames(item)];
  return new Set(texts.flatMap((text) => (typeof text === "string" ? wordsOf(text) : [])));
}

export interface Ranked {
  item: Listed;
  /** The words of the intent this resource carries, in the order the intent has them */
  matched: string[];
}

/** Orders the list by how many words of the intent each resource carries, ties keep the order of the list */
export function rankByIntent(items: readonly Listed[], intent: string): Ranked[] {
  const wanted = [...new Set(wordsOf(intent))];
  return items
    .map((item, index) => {
      const words = wordsOfResource(item);
      return { item, index, matched: wanted.filter((word) => words.has(word)) };
    })
    .sort((a, b) => b.matched.length - a.matched.length || a.index - b.index)
    .map(({ item, matched }) => ({ item, matched }));
}

function pickLine(ranked: readonly Ranked[]): string {
  const best = ranked[0];
  if (best === undefined || best.matched.length === 0) return "pick: none, no word of the intent matches a resource";
  const row = rowOf(best.item, Date.now());
  return `pick: ${row.name} ${row.method} ${row.url} (matched ${best.matched.join(", ")})`;
}

/* Asking for the list */

interface Page {
  items: Listed[];
  total: number | undefined;
}

function isListed(value: unknown): value is Listed {
  return typeof at(value, "resource") === "string";
}

/** What names an entry in a catalog, since one URL can carry a call for each method */
const keyOf = (item: Listed): string => `${str(methodOf(item)) ?? ""} ${item.resource}`;

function readPage(endpoint: string, body: unknown): Page {
  const items: unknown = at(body, "items");
  if (!Array.isArray(items)) throw new DiscoverError(`${endpoint} did not return a list of resources (no items array)`);
  const bad = items.findIndex((item: unknown) => !isListed(item));
  if (bad >= 0) throw new DiscoverError(`${endpoint} returned a list with no resource URL in entry ${bad + 1}`);
  const deep = items.findIndex((item: unknown) => nestsDeeperThan(item, MAX_DEPTH));
  if (deep >= 0) {
    throw new DiscoverError(`${endpoint} returned a list with entry ${deep + 1} nested deeper than ${MAX_DEPTH} levels`);
  }
  const total = at(body, "pagination", "total");
  return {
    items: items.filter(isListed),
    total: typeof total === "number" && Number.isSafeInteger(total) ? total : undefined,
  };
}

/* The deadline and the byte budget */

interface Run {
  endpoint: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  /** Bytes of the budget not yet read */
  left: number;
}

const runs = new AsyncLocalStorage<Run>();
let guarded = false;

function size(bytes: number): string {
  const kib = Math.round(bytes / 1024);
  return kib >= 1024 ? `${Math.round((kib / 1024) * 10) / 10} MiB` : `${kib} KiB`;
}

/** The deepest nesting of objects and arrays in JSON text, counted on the raw bytes without parsing them */
export function nestingDepth(bytes: Uint8Array): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
    } else if (byte === 0x22) {
      inString = true;
    } else if (byte === 0x7b || byte === 0x5b) {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (byte === 0x7d || byte === 0x5d) {
      depth--;
    }
  }
  return deepest;
}

/** The answer as bytes, read until the budget of the run is spent, and never past it */
async function readBytes(res: Response, run: Run): Promise<Uint8Array<ArrayBuffer>> {
  const tooBig = (): DiscoverError => new DiscoverError(`${run.endpoint} sent more than ${size(run.maxBytes)}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > run.left) {
    res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    run.left -= value.byteLength;
    if (run.left < 0) {
      reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The stock client calls the global fetch and has no way to give it a deadline or a size limit, so a fetch that acts
 * inside a run only is installed once. Other requests of the process pass through it untouched.
 */
function guardFetch(): void {
  if (guarded) return;
  guarded = true;
  const stock = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const run = runs.getStore();
    if (run === undefined) return stock(input, init);
    const res = await stock(input, { ...init, signal: run.signal });
    const bytes = await readBytes(res, run);
    const empty = res.status === 204 || res.status === 205 || res.status === 304;
    // A JSON body nested past MAX_DEPTH is refused before the stock client parses it, which would take far more memory
    if (res.ok && nestingDepth(bytes) > MAX_DEPTH) {
      throw new DiscoverError(`${run.endpoint} sent JSON nested deeper than ${MAX_DEPTH} levels`);
    }
    // No statusText: a reason phrase outside Latin-1 makes the Response constructor throw, and nothing reads it
    return new Response(empty ? null : bytes, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** The message, or the cause that fetch hides behind its own "fetch failed" */
function reasonOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause: unknown = e.cause;
  if (!(cause instanceof Error)) return e.message;
  const code: unknown = (cause as { code?: unknown }).code;
  return cause.message !== "" ? cause.message : typeof code === "string" ? code : cause.name;
}

/** One line for whichever way the stock client failed */
function failure(run: Run, e: unknown): DiscoverError {
  const { endpoint } = run;
  if (e instanceof DiscoverError) return e;
  if (e instanceof Error && e.name === "TimeoutError") {
    return new DiscoverError(`${endpoint} did not finish answering within ${run.timeoutMs / 1000} s`, { cause: e });
  }
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "SyntaxError") {
    return new DiscoverError(`${endpoint} did not return JSON: ${excerpt(message)}`, { cause: e });
  }
  const refused = /^Facilitator listDiscoveryResources failed \((\d+)\): ([\s\S]*)$/.exec(message);
  if (refused !== null) {
    const body = excerpt(refused[2] ?? "");
    return new DiscoverError(`${endpoint} answered ${refused[1]}${body === "" ? "" : `: ${body}`}`, { cause: e });
  }
  return new DiscoverError(`cannot reach ${endpoint}: ${excerpt(reasonOf(e))}`, { cause: e });
}

const shown = (count: number, total: number | undefined): string =>
  `showing the first ${count}${total === undefined ? "" : ` of ${total}`} resources`;

/** The stock call, repeated with an offset while the service says there is more */
async function listAll(base: string, io: DiscoverIo, limits: DiscoverLimits): Promise<Listed[]> {
  const endpoint = `${base}${LIST_PATH}`;
  const bazaar = withBazaar(new HTTPFacilitatorClient({ url: base })).extensions.bazaar;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const run: Run = { endpoint, timeoutMs, maxBytes, signal: AbortSignal.timeout(timeoutMs), left: maxBytes };
  guardFetch();

  return runs.run(run, async () => {
    const items: Listed[] = [];
    const known = new Set<string>();
    let offset = 0;
    let total: number | undefined;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      let page: Page;
      try {
        page = readPage(endpoint, await bazaar.listResources({ type: "http", ...(offset > 0 && { offset }) }));
      } catch (e) {
        throw failure(run, e);
      }
      total = page.total;
      // The service counts what it sent, repeats included, so the next offset follows that and not the list kept here
      offset += page.items.length;
      let added = 0;
      for (const item of page.items) {
        // One entry past the limit is enough to know that the list goes on
        if (items.length > MAX_RESOURCES) break;
        const key = keyOf(item);
        if (known.has(key)) continue;
        known.add(key);
        items.push(item);
        added++;
      }
      if (items.length > MAX_RESOURCES) {
        items.length = MAX_RESOURCES;
        io.warn(shown(items.length, total));
        return items;
      }
      // The service has sent as many entries as it counts, repeats included, so asking again would only repeat them
      if (total === undefined || offset >= total) return items;
      // A page with nothing new is a service that ignores offset and sends the first page again
      if (added === 0) {
        io.warn(`${shown(items.length, total)}: the service sent no further page`);
        return items;
      }
      if (items.length >= MAX_RESOURCES) break;
    }
    io.warn(shown(items.length, total));
    return items;
  });
}

/* The command */

export async function runDiscover(flags: DiscoverFlags, io: DiscoverIo, limits: DiscoverLimits = {}): Promise<void> {
  const items = await listAll(flags.discovery, io, limits);
  if (flags.json) {
    io.print(printableJson(JSON.stringify(items, null, 2)));
    return;
  }
  if (items.length === 0) {
    io.print(`no resources listed at ${flags.discovery}`);
    return;
  }
  if (flags.intent === undefined) {
    for (const line of listLines(items)) io.print(line);
    return;
  }
  const ranked = rankByIntent(items, flags.intent);
  // The intent can come from a model's own text, so it is shown quoted and with no raw terminal character either
  const heading = `ranked locally by word overlap with ${printableJson(JSON.stringify(flags.intent))}`;
  io.print(`${heading}, only the list request left this process`);
  for (const line of listLines(ranked.map((r) => r.item))) io.print(line);
  io.print(pickLine(ranked));
}

/** Parses the arguments after "discover" and runs the command, returns the exit code */
export async function discoverMain(
  args: readonly string[],
  io: DiscoverIo = { print: console.log, warn: console.error },
  limits: DiscoverLimits = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.print(DISCOVER_USAGE);
    return 0;
  }
  let flags: DiscoverFlags;
  try {
    flags = parseDiscoverFlags(args);
  } catch (e) {
    if (!(e instanceof FlagError)) throw e;
    io.warn(`${e.message}\n\n${DISCOVER_USAGE}`);
    return 2;
  }
  try {
    await runDiscover(flags, io, limits);
    return 0;
  } catch (e) {
    if (!(e instanceof DiscoverError)) throw e;
    io.warn(e.message);
    return 1;
  }
}
