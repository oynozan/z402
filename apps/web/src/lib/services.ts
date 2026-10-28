/**
 * Turns what discovery serves into the rows the site shows. `parseResources` and `parseStatus` accept any JSON and
 * keep only what they can read, `groupOffers` groups the paid routes by service name and `mergeStatus` lays the status
 * of each service over its group. The server and the browser both run these, so a polled update renders the same way
 * the first paint did.
 */
import type {
  BodyType,
  DiscoverySnapshot,
  Json,
  Offer,
  RouteInput,
  RouteTerms,
  ServiceStatus,
} from "./discovery-types";
import { countOf, textOf, zatDigits } from "./format";

export type Health = "up" | "starting" | "down" | "unknown";

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
  /** The first tag discovery lists for the service, or OTHER */
  category: string;
  tags: string[];
  routes: RouteRow[];
  notes: string[];
  health: Health;
  latencyMs: number | null;
  callsToday: number | null;
  /** From status, for a service whose routes discovery has not listed yet */
  unit: string | null;
  priceZat: string | null;
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

function record(value: unknown): Record<string, unknown> | null {
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
    });
  }
  return offers;
}

function latencyOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

export function parseStatus(json: unknown): ServiceStatus[] | null {
  const top = record(json);
  const services = Array.isArray(json) ? json : top?.services;
  if (!Array.isArray(services)) return null;
  const out: ServiceStatus[] = [];
  for (const raw of services) {
    const entry = record(raw);
    if (entry === null) continue;
    out.push({
      serviceName: textOf(entry.serviceName),
      url: textOf(entry.url),
      up: entry.up === true,
      ready: typeof entry.ready === "boolean" ? entry.ready : null,
      latencyMs: latencyOf(entry.latencyMs),
      callsToday: countOf(entry.callsToday),
      unit: textOf(entry.unit),
      priceZat: zatDigits(entry.priceZat),
    });
  }
  return out;
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

/** One row per service name, in the order discovery first lists each, its routes in their own order */
export function groupOffers(offers: readonly Offer[]): ServiceRow[] {
  const rows = new Map<string, ServiceRow>();
  for (const offer of offers) {
    const name = offer.serviceName ?? hostOf(offer.url);
    const key = offer.serviceName === null ? `origin:${originOf(offer.url) ?? offer.url}` : `name:${name}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        key,
        name,
        category: OTHER,
        tags: [],
        routes: [],
        notes: [],
        health: "unknown",
        latencyMs: null,
        callsToday: null,
        unit: null,
        priceZat: null,
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
  }
  return [...rows.values()];
}

export function healthOf(status: ServiceStatus | undefined): Health {
  if (status === undefined) return "unknown";
  if (!status.up) return "down";
  return status.ready === false ? "starting" : "up";
}

function matches(row: ServiceRow, status: ServiceStatus): boolean {
  if (status.serviceName !== null && row.key === `name:${status.serviceName}`) return true;
  const origin = status.url === null ? null : originOf(status.url);
  return origin !== null && row.routes.some((r) => originOf(r.url) === origin);
}

/** Lays each status entry over its row, and adds a row for a service discovery knows by status alone */
export function mergeStatus(rows: readonly ServiceRow[], status: readonly ServiceStatus[] | null): ServiceRow[] {
  const entries = status ?? [];
  const used = new Set<ServiceStatus>();
  const merged = rows.map((row) => {
    const entry = entries.find((s) => !used.has(s) && matches(row, s));
    if (entry !== undefined) used.add(entry);
    return {
      ...row,
      health: healthOf(entry),
      latencyMs: entry?.latencyMs ?? null,
      callsToday: entry?.callsToday ?? null,
      unit: entry?.unit ?? null,
      priceZat: entry?.priceZat ?? null,
    };
  });
  for (const entry of entries) {
    if (used.has(entry)) continue;
    const name = entry.serviceName ?? (entry.url === null ? null : hostOf(entry.url));
    if (name === null) continue;
    merged.push({
      key: entry.serviceName === null ? `origin:${entry.url}` : `name:${entry.serviceName}`,
      name,
      category: OTHER,
      tags: [],
      routes: [],
      notes: [],
      health: healthOf(entry),
      latencyMs: entry.latencyMs,
      callsToday: entry.callsToday,
      unit: entry.unit,
      priceZat: entry.priceZat,
    });
  }
  return merged;
}

export function buildBoard(snapshot: DiscoverySnapshot): Board {
  if (snapshot.offers === null && snapshot.status === null) return { state: "unreachable", services: [] };
  const services = mergeStatus(groupOffers(snapshot.offers ?? []), snapshot.status);
  return { state: services.length === 0 ? "empty" : "ready", services };
}
