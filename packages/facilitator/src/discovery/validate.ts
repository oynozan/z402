/**
 * What the Bazaar catalog accepts (design §4.4). A declaration is checked whole and strictly, and one bad item refuses
 * the call. A payment lists less, since its payer echoes the resource and the extensions and nothing checks them: only
 * the mimeType and the bazaar extension are read, through the same field checks, and a field that fails is dropped and
 * nothing is refused. Messages name a field and a rule and never a value, since a value may carry a query string.
 */
import type { Network } from "@x402/core/types";
import { encodeTerms, parseTerms, parseZat, ASSET, SCHEME, type Terms } from "@z402/protocol";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type Method = (typeof METHODS)[number];

/** The provider a call is made for, as the authenticated runtime knows it */
export interface CatalogProvider {
  id: string;
  network: string;
  payTo: string;
  terms: Terms;
  termsVersion: string;
}

/** A declaration the catalog refuses, answered with 400 and naming the item by `index` unless the body is wrong */
export class CatalogError extends Error {
  readonly index?: number;

  constructor(message: string, index?: number) {
    super(message);
    this.name = "CatalogError";
    this.index = index;
  }
}

/** A list or search query the catalog refuses, answered with 400 */
export class CatalogQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogQueryError";
  }
}

/** A standard x402 PaymentRequirements entry, rebuilt from the checked fields alone */
export interface Accept {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface Meta {
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** What a declaration, or the payment that creates an item, decides about it */
export interface Fields extends Meta {
  accepts: Accept[];
  extensions?: Record<string, unknown>;
}

export interface Declared extends Fields {
  resource: string;
  method: Method;
}

/** An item as the catalog keeps it and writes it to the file */
export interface Stored extends Fields {
  providerId: string;
  resource: string;
  method: Method;
  source: "declared" | "payment";
  firstListed: string;
  lastSeen?: string;
  lastPaid?: string;
  /** The UTC day, YYYY-MM-DD, that `paidCount` counts */
  paidDay?: string;
  paidCount: number;
}

/** What the file holds */
export interface Store {
  declared: string[];
  items: Stored[];
}

/** A settled payment reduced to what the catalog reads from it */
export interface Payment {
  resource: string;
  method: Method;
  /** The echoed `extensions.bazaar`, when it is a plain object */
  bazaar: Record<string, unknown> | undefined;
  /** The echoed `resource` object */
  info: Record<string, unknown>;
}

export interface Filters {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  extensions?: string;
}

export interface ListQuery extends Filters {
  limit: number;
  offset: number;
}

export interface SearchQuery extends Filters {
  query: string;
  limit: number;
  /** A decimal offset */
  cursor?: string;
}

export const STORE_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const MAX_ITEMS_PER_CALL = 32;
const MAX_ACCEPTS = 4;
const MAX_URL = 2048;
const MAX_DESCRIPTION = 512;
const MAX_MIME_TYPE = 128;
const MAX_LABEL = 32;
const MAX_TAGS = 5;
const MAX_EXTENSIONS_BYTES = 8192;
const MAX_QUERY = 256;
/** Fifteen digits always fit a safe integer */
const MAX_DIGITS = 15;
const MAX_DECODE_PASSES = 5;

const PRINTABLE = /^[\x20-\x7e]+$/;
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;
const AUTHORITY = /^https?:\/\/([^/?#]*)/i;
const ROUTE_TEMPLATE = /^\/[a-zA-Z0-9_/:.\-~%]+$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);
const NOT_A_URL = `must be an absolute http(s) URL of at most ${MAX_URL} characters, without userinfo`;
const NOT_AN_ICON = `must be an http(s) URL of at most ${MAX_URL} characters, without userinfo, on a named host`;
const FILTERS = ["type", "payTo", "scheme", "network", "extensions"] as const;

const bad = (field: string, reason: string): CatalogError => new CatalogError(`${field}: ${reason}`);

/** A plain object, from this realm or another, which is all a JSON body can hold */
function isPlain(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function keyOf(providerId: string, resource: string, method: string): string {
  return JSON.stringify([providerId, resource, method]);
}

const isMethod = (v: unknown): v is Method => typeof v === "string" && (METHODS as readonly string[]).includes(v);

/* URLs and the canonical resource */

function parseUrl(raw: unknown, field: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL) throw bad(field, NOT_A_URL);
  const authority = AUTHORITY.exec(raw)?.[1];
  // The URL parser forgives a backslash, an empty userinfo and stray whitespace, so none of them gets that far
  if (authority === undefined || authority === "" || authority.includes("@")) throw bad(field, NOT_A_URL);
  if (raw.includes("\\") || CONTROL_OR_SPACE.test(raw)) throw bad(field, NOT_A_URL);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad(field, NOT_A_URL);
  }
  if (url.username !== "" || url.password !== "") throw bad(field, NOT_A_URL);
  return url;
}

/** The decode loop of @x402/extensions, so that a provider and a payer key a route template the same way */
function decodedToFixedPoint(value: string): string | undefined {
  let decoded = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return undefined;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return undefined;
}

function isValidRouteTemplate(value: unknown): value is string {
  if (typeof value !== "string" || !ROUTE_TEMPLATE.test(value)) return false;
  const decoded = decodedToFixedPoint(value);
  return decoded !== undefined && !decoded.includes("..") && !decoded.includes("://");
}

function bazaarOf(extensions: unknown): Record<string, unknown> | undefined {
  return isPlain(extensions) && isPlain(extensions.bazaar) ? extensions.bazaar : undefined;
}

function methodOf(bazaar: Record<string, unknown> | undefined): unknown {
  const input = isPlain(bazaar?.info) ? bazaar.info.input : undefined;
  return isPlain(input) ? input.method : undefined;
}

/** The origin plus the route template when it is valid, else the path, so the query and fragment never reach a key */
function canonicalOf(url: URL, bazaar: Record<string, unknown> | undefined): string {
  const template = bazaar?.routeTemplate;
  return url.origin + (isValidRouteTemplate(template) ? template : url.pathname);
}

/* Metadata */

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw bad(field, `must be a string of at most ${max} characters`);
  return value;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_LABEL || !PRINTABLE.test(value)) {
    throw bad(field, `must be 1 to ${MAX_LABEL} printable ASCII characters`);
  }
  return value;
}

function tags(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw bad(field, `must be an array of at most ${MAX_TAGS} tags`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of Array.from(value, (entry, i) => label(entry, `${field}[${i}]`))) {
    const folded = tag.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw bad(field, `must hold at most ${MAX_TAGS} distinct tags`);
  return out;
}

/** The @x402/extensions rule for an icon, which a browser fetches, so no host that names the visitor's own machine */
function isValidIconUrl(value: unknown): value is string {
  let url: URL;
  try {
    url = parseUrl(value, "iconUrl");
  } catch {
    return false;
  }
  if (url.host.startsWith("[")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return false;
  // The URL parser has already turned a decimal or hex host into dotted form, or refused it
  return !IPV4.test(host);
}

function icon(value: unknown, field: string): string {
  if (!isValidIconUrl(value)) throw bad(field, NOT_AN_ICON);
  return value;
}

/** Reads the optional metadata, refusing a bad field or, when lenient, dropping it */
function parseMeta(raw: Record<string, unknown>, at: string, lenient: boolean): Meta {
  const out: Meta = {};
  const take = <K extends keyof Meta>(key: K, read: (v: unknown, field: string) => NonNullable<Meta[K]>): void => {
    const value = raw[key];
    if (value === undefined) return;
    try {
      out[key] = read(value, `${at}.${key}`);
    } catch (e) {
      if (!lenient || !(e instanceof CatalogError)) throw e;
    }
  };
  take("description", (v, f) => text(v, f, MAX_DESCRIPTION));
  take("mimeType", (v, f) => text(v, f, MAX_MIME_TYPE));
  take("serviceName", label);
  take("tags", tags);
  take("iconUrl", icon);
  return out;
}

function parseExtensions(value: unknown, field: string): Record<string, unknown> {
  if (!isPlain(value)) throw bad(field, "must be a JSON object");
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw bad(field, "must be JSON");
  if (Buffer.byteLength(json, "utf8") > MAX_EXTENSIONS_BYTES) {
    throw bad(field, `must be at most ${MAX_EXTENSIONS_BYTES} bytes as JSON`);
  }
  // Copied through JSON, since structuredClone overflows the stack on nesting the byte cap still allows
  const copy: unknown = JSON.parse(json);
  if (!isPlain(copy)) throw bad(field, "must be a JSON object");
  return copy;
}

/* Payment requirements */

function sameTerms(a: Terms, b: Terms): boolean {
  return (
    a.windowZat === b.windowZat &&
    a.creditRatioBps === b.creditRatioBps &&
    a.creditCapZat === b.creditCapZat &&
    a.zeroConfMinExpiryBlocks === b.zeroConfMinExpiryBlocks
  );
}

function isPrice(amount: unknown, max: bigint): amount is string {
  if (typeof amount !== "string") return false;
  try {
    const zat = parseZat(amount);
    return zat >= 1n && zat <= max;
  } catch {
    return false;
  }
}

/** Checks that the facilitator would take a payment on these requirements, so the catalog never lists one it refuses */
function parseAccept(p: CatalogProvider, raw: unknown, at: string): Accept {
  if (!isPlain(raw)) throw bad(at, "must be an object");
  if (raw.scheme !== SCHEME) throw bad(`${at}.scheme`, `must be ${SCHEME}`);
  if (raw.network !== p.network) throw bad(`${at}.network`, `must be ${p.network}`);
  if (raw.asset !== ASSET) throw bad(`${at}.asset`, `must be ${ASSET}`);
  if (raw.payTo !== p.payTo) throw bad(`${at}.payTo`, "must be the payTo of this provider");
  const { amount, maxTimeoutSeconds, extra } = raw;
  if (!isPrice(amount, p.terms.windowZat)) {
    throw bad(`${at}.amount`, `must be a canonical zat amount from 1 to ${p.terms.windowZat}`);
  }
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw bad(`${at}.maxTimeoutSeconds`, "must be a positive number");
  }
  let terms: Terms;
  try {
    terms = parseTerms(extra);
  } catch {
    throw bad(`${at}.extra`, "must carry the terms of the rail");
  }
  if (!sameTerms(terms, p.terms)) throw bad(`${at}.extra`, "must carry the terms of the rail");
  if ((extra as Record<string, unknown>).termsVersion !== p.termsVersion) {
    throw bad(`${at}.extra.termsVersion`, "must be the termsVersion of the rail");
  }
  return {
    scheme: SCHEME,
    network: p.network as Network,
    asset: ASSET,
    amount,
    payTo: p.payTo,
    maxTimeoutSeconds,
    extra: { ...encodeTerms(p.terms), termsVersion: p.termsVersion },
  };
}

function parseAccepts(p: CatalogProvider, raw: unknown, at: string): Accept[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ACCEPTS) {
    throw bad(at, `must be an array of 1 to ${MAX_ACCEPTS} entries`);
  }
  return Array.from(raw, (entry, i) => parseAccept(p, entry, `${at}[${i}]`));
}

/* Declarations */

function parseItem(p: CatalogProvider, raw: Record<string, unknown>, at: string): Declared {
  const url = parseUrl(raw.resource, `${at}.resource`);
  if (raw.type !== "http") throw bad(`${at}.type`, 'must be "http"');
  if (raw.x402Version !== 2) throw bad(`${at}.x402Version`, "must be 2");
  const accepts = parseAccepts(p, raw.accepts, `${at}.accepts`);
  const meta = parseMeta(raw, at, false);
  const extensions = raw.extensions === undefined ? undefined : parseExtensions(raw.extensions, `${at}.extensions`);

  const bazaar = bazaarOf(extensions);
  const resource = canonicalOf(url, bazaar);
  if (resource.length > MAX_URL) throw bad(`${at}.resource`, `canonical form is over ${MAX_URL} characters`);
  const declared = methodOf(bazaar);
  if (declared !== undefined && !isMethod(declared)) {
    throw bad(`${at}.extensions.bazaar.info.input.method`, `must be one of ${METHODS.join(", ")}`);
  }
  const method = isMethod(declared) ? declared : "GET";
  return { resource, method, accepts, ...meta, ...(extensions === undefined ? {} : { extensions }) };
}

/** Validates the whole body before anything is applied, naming the first bad item by its index */
export function parseDeclaration(p: CatalogProvider, body: unknown): Declared[] {
  if (!isPlain(body)) throw new CatalogError("body: must be a JSON object");
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_CALL) {
    throw new CatalogError(`items: must be an array of 1 to ${MAX_ITEMS_PER_CALL} resources`);
  }
  return Array.from(items, (raw: unknown, index) => {
    const at = `items[${index}]`;
    try {
      if (!isPlain(raw)) throw bad(at, "must be an object");
      return parseItem(p, raw, at);
    } catch (e) {
      throw e instanceof CatalogError ? new CatalogError(e.message, index) : e;
    }
  });
}

/* Payments */

/** Undefined for a payment the catalog does not read, which is any but a v2 payload with a usable resource URL */
export function readPayment(payload: unknown): Payment | undefined {
  if (!isPlain(payload) || payload.x402Version !== 2) return undefined;
  const info = payload.resource;
  if (!isPlain(info)) return undefined;
  let url: URL;
  try {
    url = parseUrl(info.url, "resource.url");
  } catch (e) {
    if (e instanceof CatalogError) return undefined;
    throw e;
  }
  const bazaar = bazaarOf(payload.extensions);
  const resource = canonicalOf(url, bazaar);
  if (resource.length > MAX_URL) return undefined;
  const method = methodOf(bazaar);
  return { resource, method: isMethod(method) ? method : "GET", bazaar, info };
}

/** The fields of an item created from a payment, or undefined when the payment cannot list one */
export function paymentFields(p: CatalogProvider, requirements: unknown, payment: Payment): Fields | undefined {
  if (payment.bazaar === undefined) return undefined;
  try {
    return {
      accepts: [parseAccept(p, requirements, "requirements")],
      // The mimeType alone, since a payer echoes the rest and nothing checks it
      ...parseMeta({ mimeType: payment.info.mimeType }, "resource", true),
      extensions: parseExtensions({ bazaar: payment.bazaar }, "extensions"),
    };
  } catch (e) {
    if (e instanceof CatalogError) return undefined;
    throw e;
  }
}

/* The file */

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw bad(field, "must be an ISO 8601 UTC time");
  }
  return value;
}

function storedAccept(raw: unknown, at: string): Accept {
  if (!isPlain(raw)) throw bad(at, "must be an object");
  const { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra } = raw;
  const strings = [scheme, network, asset, amount, payTo];
  if (strings.some((s) => typeof s !== "string") || !isPlain(extra))
    throw bad(at, "is not a payment requirements entry");
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw bad(`${at}.maxTimeoutSeconds`, "must be a positive number");
  }
  return { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra: { ...extra } } as Accept;
}

function storedItem(raw: unknown, at: string): Stored {
  if (!isPlain(raw)) throw bad(at, "must be an object");
  const { providerId, resource, method, source, accepts, paidDay, paidCount } = raw;
  if (typeof providerId !== "string" || providerId === "") throw bad(`${at}.providerId`, "must be a string");
  if (typeof resource !== "string" || resource === "" || resource.length > MAX_URL)
    throw bad(`${at}.resource`, NOT_A_URL);
  if (!isMethod(method)) throw bad(`${at}.method`, `must be one of ${METHODS.join(", ")}`);
  if (source !== "declared" && source !== "payment") throw bad(`${at}.source`, "must be declared or payment");
  if (!Array.isArray(accepts) || accepts.length < 1 || accepts.length > MAX_ACCEPTS) {
    throw bad(`${at}.accepts`, `must be an array of 1 to ${MAX_ACCEPTS} entries`);
  }
  if (paidDay !== undefined && (typeof paidDay !== "string" || !DAY.test(paidDay))) {
    throw bad(`${at}.paidDay`, "must be a UTC day");
  }
  if (typeof paidCount !== "number" || !Number.isSafeInteger(paidCount) || paidCount < 0) {
    throw bad(`${at}.paidCount`, "must be a whole number");
  }
  const item: Stored = {
    providerId,
    resource,
    method,
    source,
    accepts: Array.from(accepts, (entry, i) => storedAccept(entry, `${at}.accepts[${i}]`)),
    ...parseMeta(raw, at, false),
    firstListed: iso(raw.firstListed, `${at}.firstListed`),
    paidCount,
  };
  if (raw.extensions !== undefined) item.extensions = parseExtensions(raw.extensions, `${at}.extensions`);
  if (raw.lastSeen !== undefined) item.lastSeen = iso(raw.lastSeen, `${at}.lastSeen`);
  if (raw.lastPaid !== undefined) item.lastPaid = iso(raw.lastPaid, `${at}.lastPaid`);
  if (paidDay !== undefined) item.paidDay = paidDay as string;
  return item;
}

/** Reads the catalog file, refusing it whole when anything in it is off */
export function parseStore(raw: unknown): Store {
  if (!isPlain(raw) || raw.version !== STORE_VERSION) throw bad("file", `is not a version ${STORE_VERSION} catalog`);
  const { declared, items } = raw;
  if (!Array.isArray(declared) || declared.some((id) => typeof id !== "string")) {
    throw bad("declared", "must be an array of provider ids");
  }
  if (!Array.isArray(items)) throw bad("items", "must be an array");
  const seen = new Set<string>();
  const stored = Array.from(items, (entry, i) => {
    const item = storedItem(entry, `items[${i}]`);
    const key = keyOf(item.providerId, item.resource, item.method);
    if (seen.has(key)) throw bad(`items[${i}]`, "repeats an earlier item");
    seen.add(key);
    return item;
  });
  return { declared: declared as string[], items: stored };
}

/* Queries */

function single(q: Record<string, unknown>, name: string): string | undefined {
  const value = q[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CatalogQueryError(`${name}: must be given once, as a string`);
  return value;
}

function decimal(name: string, value: string): number {
  if (!DECIMAL.test(value)) throw new CatalogQueryError(`${name}: must be a non-negative decimal integer`);
  if (value.length > MAX_DIGITS) throw new CatalogQueryError(`${name}: is too large`);
  return Number(value);
}

function filtersOf(q: Record<string, unknown>): Filters {
  const out: Filters = {};
  for (const name of FILTERS) {
    const value = single(q, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Limit clamped to 1..100, whatever number it is given */
export function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function limitOf(q: Record<string, unknown>): number {
  const value = single(q, "limit");
  if (value === undefined) return DEFAULT_LIMIT;
  if (!DECIMAL.test(value)) throw new CatalogQueryError("limit: must be a non-negative decimal integer");
  return clampLimit(Number(value));
}

export function offsetOf(offset: unknown): number {
  if (offset === undefined) return 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new CatalogQueryError("offset: must be a non-negative integer");
  }
  return offset;
}

/** The offset a search cursor stands for, which is the cursor itself */
export function cursorOffset(cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw new CatalogQueryError("cursor: must be given once, as a string");
  return decimal("cursor", cursor);
}

export function checkQuery(query: unknown): string {
  if (query === undefined) throw new CatalogQueryError("query: is required");
  if (typeof query !== "string" || query.length < 1 || query.length > MAX_QUERY) {
    throw new CatalogQueryError(`query: must be 1 to ${MAX_QUERY} characters`);
  }
  return query;
}

/** Reads the query of `GET /discovery/resources`, where Express may hand an array for a repeated parameter */
export function parseListQuery(q: Record<string, unknown>): ListQuery {
  const params = q ?? {};
  const offset = single(params, "offset");
  return { ...filtersOf(params), limit: limitOf(params), offset: offset === undefined ? 0 : decimal("offset", offset) };
}

/** Reads the query of `GET /discovery/search` */
export function parseSearchQuery(q: Record<string, unknown>): SearchQuery {
  const params = q ?? {};
  const query = checkQuery(single(params, "query"));
  const cursor = single(params, "cursor");
  cursorOffset(cursor);
  return { ...filtersOf(params), query, limit: limitOf(params), ...(cursor === undefined ? {} : { cursor }) };
}
