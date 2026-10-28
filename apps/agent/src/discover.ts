/**
 * The discover subcommand. It lists what a Bazaar endpoint knows with the stock client, withBazaar over an
 * HTTPFacilitatorClient, the way any agent would without z402 code. With --intent the list is ranked here by word
 * overlap, so the service never learns what an agent wants.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar, type DiscoveryResource } from "@x402/extensions/bazaar";
import { ASSET } from "@z402/protocol";
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

/** One entry of the list, of which only the URL is certain */
export type Listed = Partial<DiscoveryResource> & { resource: string };

const LIST_PATH = "/discovery/resources";
/** Where a longer list is cut, the same 1000 the discovery service allows in one page */
const MAX_RESOURCES = 1000;
const EXCERPT_CHARS = 120;
const MIN_WORD_CHARS = 3;

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

/** One line, so that a newline or a terminal escape in the service's text cannot break the list */
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

function excerpt(text: string): string {
  const line = oneLine(text);
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line;
}

/* The list lines */

interface Row {
  name: string;
  method: string;
  url: string;
  price: string;
  description: string;
}

function priceOf(item: Listed): string {
  const amount = at(item, "accepts", "0", "amount");
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return "-";
  const asset = str(at(item, "accepts", "0", "asset"));
  const price = asset === ASSET ? `${formatZat(amount)} zat` : `${amount} ${asset ?? ""}`;
  const unit = oneLine(str(at(item, "extensions", "z402", "unit")) ?? "");
  return unit === "" ? price : `${price} per ${unit}`;
}

function rowOf(item: Listed): Row {
  const cell = (value: unknown): string => oneLine(str(value) ?? "") || "-";
  return {
    name: cell(item.serviceName),
    method: cell(methodOf(item)),
    url: cell(item.resource),
    price: oneLine(priceOf(item)),
    description: oneLine(str(item.description) ?? ""),
  };
}

/** One aligned line per resource with its service, method, URL, price and unit, then the description */
export function listLines(items: readonly Listed[]): string[] {
  const rows = items.map(rowOf);
  const widest = (cell: (row: Row) => string): number => Math.max(...rows.map((row) => cell(row).length));
  const width = {
    name: widest((r) => r.name),
    method: widest((r) => r.method),
    url: widest((r) => r.url),
    price: widest((r) => r.price),
  };
  return rows.map((r) =>
    [
      r.name.padEnd(width.name),
      r.method.padEnd(width.method),
      r.url.padEnd(width.url),
      r.price.padEnd(width.price),
      r.description,
    ]
      .join("  ")
      .trimEnd(),
  );
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
  const row = rowOf(best.item);
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
  const total = at(body, "pagination", "total");
  return {
    items: items.filter(isListed),
    total: typeof total === "number" && Number.isSafeInteger(total) ? total : undefined,
  };
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
function failure(endpoint: string, e: unknown): DiscoverError {
  if (e instanceof DiscoverError) return e;
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

/** The stock call, repeated with an offset while the service says there is more */
async function listAll(base: string, io: DiscoverIo): Promise<Listed[]> {
  const endpoint = `${base}${LIST_PATH}`;
  const bazaar = withBazaar(new HTTPFacilitatorClient({ url: base })).extensions.bazaar;
  const items: Listed[] = [];
  for (;;) {
    let page: Page;
    try {
      const offset = items.length > 0 ? { offset: items.length } : {};
      page = readPage(endpoint, await bazaar.listResources({ type: "http", ...offset }));
    } catch (e) {
      throw failure(endpoint, e);
    }
    // A service that ignores offset sends the first page again
    const known = new Set(items.map(keyOf));
    if (page.items.length === 0 || page.items.every((item) => known.has(keyOf(item)))) break;
    items.push(...page.items);
    if (page.total === undefined || items.length >= page.total) break;
    if (items.length >= MAX_RESOURCES) {
      io.warn(`showing the first ${items.length} of ${page.total} resources`);
      break;
    }
  }
  return items;
}

/* The command */

export async function runDiscover(flags: DiscoverFlags, io: DiscoverIo): Promise<void> {
  const items = await listAll(flags.discovery, io);
  if (flags.json) {
    io.print(JSON.stringify(items, null, 2));
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
  const heading = `ranked locally by word overlap with ${JSON.stringify(flags.intent)}`;
  io.print(`${heading}, only the list request left this process`);
  for (const line of listLines(ranked.map((r) => r.item))) io.print(line);
  io.print(pickLine(ranked));
}

/** Parses the arguments after "discover" and runs the command, returns the exit code */
export async function discoverMain(
  args: readonly string[],
  io: DiscoverIo = { print: console.log, warn: console.error },
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
    await runDiscover(flags, io);
    return 0;
  } catch (e) {
    if (!(e instanceof DiscoverError)) throw e;
    io.warn(e.message);
    return 1;
  }
}
