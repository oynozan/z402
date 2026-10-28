/**
 * Turns the Bazaar list into the rows the site shows. `parseResources` accepts any JSON and keeps only what it can
 * read, and `groupOffers` makes one row per service and reads its status from the age of its latest declaration. The
 * server and the browser both run these, so a polled update renders the same way the first paint did.
 */
import type { BodyType, DiscoverySnapshot, Json, Offer, RouteInput, RouteTerms } from "./discovery-types";
import { countOf, textOf, zatDigits } from "./format";

/**
 * Up, stale or down from the age of the service's latest declaration, none for a service listed from its paid calls
 * alone, and unknown while the list cannot be read
 */
export type Health = "up" | "stale" | "down" | "none" | "unknown";

export interface RouteRow {
  method: string;
  /** The path and query as a reader sees them, e.g. /v1/drops/:id/hold */
  path: string;
  url: string;
  description: string | null;
  unit: string | null;
  note: string | null;
  priceZat: string | null;
  input: RouteInput | null;
  output: string | null;
  terms: RouteTerms | null;
}

export interface ServiceRow {
  key: string;
  name: string;
  /** The first tag the Bazaar lists for the service, or OTHER */
  category: string;
  tags: string[];
  routes: RouteRow[];
  notes: string[];
  /** The latest declaration of any of its routes, in ms since the epoch */
  lastSeen: number | null;
  health: Health;
  /** The paid calls of its routes since 00:00 UTC, null when none of them says */
  callsToday: number | null;
}

export type BoardState = "ready" | "empty" | "unreachable";

export interface Board {
  state: BoardState;
  services: ServiceRow[];
}

export const OTHER = "other";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const BODY_TYPES: ReadonlySet<string> = new Set<BodyType>(["json", "form-data", "text"]);
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 32;
/** An answer longer than this is cut, the panel shows its shape and not a whole document */
const MAX_OUTPUT_CHARS = 4_000;
const MAX_BPS = 10_000;
/** The facilitator's reading of a declaration's age: up under 90 s, stale under 10 min, down after */
const UP_MS = 90_000;
const STALE_MS = 600_000;
/** ISO 8601 as the facilitator writes it, so no looser date format reaches Date.parse */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function itemsOf(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  const items = record(json)?.items;
  return Array.isArray(items) ? items : null;
}

function bazaarInfo(extensions: Record<string, unknown> | null): Record<string, unknown> | null {
  return record(record(extensions?.bazaar)?.info);
}

/** The method bazaar declared, else POST for a route that takes a body, else GET */
function methodOf(input: Record<string, unknown> | null): string {
  const declared = textOf(input?.method)?.toUpperCase();
  if (declared !== undefined && METHODS.has(declared)) return declared;
  return typeof input?.bodyType === "string" && BODY_TYPES.has(input.bodyType) ? "POST" : "GET";
}

/** Flat parameters as strings, null when there are none */
function paramsOf(value: unknown): Record<string, string> | null {
  const params = record(value);
  if (params === null) return null;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(params)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[name] = String(raw);
  }
  return Object.keys(out).length === 0 ? null : out;
}

function inputOf(input: Record<string, unknown> | null): RouteInput | null {
  if (input === null) return null;
  const bodyType = typeof input.bodyType === "string" && BODY_TYPES.has(input.bodyType) ? (input.bodyType as BodyType) : null;
  // What JSON.parse produced is JSON, and a body bazaar left out is no body
  const body = bodyType === null || input.body === undefined ? null : (input.body as Json);
  return { queryParams: paramsOf(input.queryParams), pathParams: paramsOf(input.pathParams), bodyType, body };
}

function outputOf(info: Record<string, unknown> | null): string | null {
  const example = record(info?.output)?.example;
  if (example === undefined) return null;
  const text = JSON.stringify(example, null, 2);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
}

/** The first entry an agent could pay, the one whose amount the site shows */
function acceptOf(accepts: unknown): Record<string, unknown> | null {
  if (!Array.isArray(accepts)) return null;
  for (const entry of accepts) {
    const offer = record(entry);
    if (offer !== null && zatDigits(offer.amount) !== null) return offer;
  }
  return null;
}

function bpsOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_BPS ? value : null;
}

function termsOf(offer: Record<string, unknown> | null): RouteTerms | null {
  if (offer === null) return null;
  const extra = record(offer.extra);
  return {
    scheme: textOf(offer.scheme),
    network: textOf(offer.network),
    asset: textOf(offer.asset),
    payTo: textOf(offer.payTo),
    windowZat: zatDigits(extra?.windowZat),
    creditRatioBps: bpsOf(extra?.creditRatioBps),
    creditCapZat: zatDigits(extra?.creditCapZat),
  };
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const raw of value) {
    const tag = textOf(raw)?.toLowerCase();
    if (tag === undefined || tag.length > MAX_TAG_CHARS || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function parseResources(json: unknown): Offer[] | null {
  const items = itemsOf(json);
  if (items === null) return null;
  const offers: Offer[] = [];
  for (const raw of items) {
    const item = record(raw);
    const url = textOf(item?.resource);
    if (item === null || url === null) continue;
    const extensions = record(item.extensions);
    const info = bazaarInfo(extensions);
    const input = record(info?.input);
    const z402 = record(extensions?.z402);
    const offer = acceptOf(item.accepts);
    offers.push({
      url,
      serviceName: textOf(item.serviceName),
      method: methodOf(input),
      description: textOf(item.description),
      unit: textOf(z402?.unit),
      note: textOf(z402?.note),
      priceZat: zatDigits(offer?.amount),
      tags: tagsOf(item.tags),
      input: inputOf(input),
      output: outputOf(info),
      terms: termsOf(offer),
      lastSeen: timeOf(item.lastSeen),
      paidCallsToday: countOf(item.paidCallsToday),
    });
  }
  return offers;
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let path = parsed.pathname;
  try {
    path = decodeURI(path);
  } catch {}
  return `${path}${parsed.search}`;
}

/** The status a declaration gives at the time the list was read, where one dated well into the future says nothing */
export function healthOf(lastSeen: number | null, at: number | null): Health {
  if (at === null) return "unknown";
  if (lastSeen === null) return "none";
  const age = at - lastSeen;
  if (age < -UP_MS) return "unknown";
  return age < UP_MS ? "up" : age < STALE_MS ? "stale" : "down";
}

/**
 * One row per service, in the order the Bazaar first lists each, its routes in their own order. A row holds the routes
 * on one origin, paid to one address, under one name, so a name alone never joins two providers' routes: any provider
 * can declare any name.
 */
export function groupOffers(offers: readonly Offer[], at: number | null): ServiceRow[] {
  const rows = new Map<string, ServiceRow>();
  for (const offer of offers) {
    const key = JSON.stringify([originOf(offer.url) ?? offer.url, offer.terms?.payTo ?? null, offer.serviceName]);
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        key,
        name: offer.serviceName ?? hostOf(offer.url),
        category: OTHER,
        tags: [],
        routes: [],
        notes: [],
        lastSeen: null,
        health: "unknown",
        callsToday: null,
      };
      rows.set(key, row);
    }
    if (row.routes.some((r) => r.url === offer.url && r.method === offer.method)) continue;
    row.routes.push({
      method: offer.method,
      path: pathOf(offer.url),
      url: offer.url,
      description: offer.description,
      unit: offer.unit,
      note: offer.note,
      priceZat: offer.priceZat,
      input: offer.input,
      output: offer.output,
      terms: offer.terms,
    });
    for (const tag of offer.tags) if (!row.tags.includes(tag)) row.tags.push(tag);
    row.category = row.tags[0] ?? OTHER;
    if (offer.note !== null && !row.notes.includes(offer.note)) row.notes.push(offer.note);
    if (offer.lastSeen !== null) row.lastSeen = Math.max(row.lastSeen ?? offer.lastSeen, offer.lastSeen);
    if (offer.paidCallsToday !== null) row.callsToday = (row.callsToday ?? 0) + offer.paidCallsToday;
  }
  // Without a fresh read neither a status nor a count can be vouched for
  return [...rows.values()].map((row) => ({
    ...row,
    health: healthOf(row.lastSeen, at),
    callsToday: at === null ? null : row.callsToday,
  }));
}

export function buildBoard({ offers, at }: DiscoverySnapshot): Board {
  if (offers === null) return { state: "unreachable", services: [] };
  const services = groupOffers(offers, at);
  return { state: services.length === 0 ? "empty" : "ready", services };
}
