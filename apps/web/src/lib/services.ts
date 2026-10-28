/**
 * Turns what discovery serves into the rows the site shows. `parseResources` and `parseStatus` accept any JSON and
 * keep only what they can read, `buildServices` groups the paid routes by service name and lays the status of each
 * service over its group. The server and the browser both run these, so a polled update renders the same way the
 * first paint did.
 */
import type { DiscoverySnapshot, Offer, ServiceStatus } from "./discovery-types";
import { countOf, textOf, zatDigits } from "./format";

export type Health = "up" | "starting" | "down" | "unknown";

export interface RouteRow {
  method: string;
  path: string;
  url: string;
  description: string | null;
  unit: string | null;
  priceZat: string | null;
}

export interface ServiceRow {
  key: string;
  name: string;
  routes: RouteRow[];
  notes: string[];
  health: Health;
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

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const BODY_TYPES = new Set(["json", "form-data", "text"]);

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

/** The method bazaar declared, else POST for a route that takes a body, else GET */
function methodOf(extensions: Record<string, unknown> | null): string {
  const input = record(record(record(extensions?.bazaar)?.info)?.input);
  const declared = textOf(input?.method)?.toUpperCase();
  if (declared !== undefined && METHODS.has(declared)) return declared;
  return typeof input?.bodyType === "string" && BODY_TYPES.has(input.bodyType) ? "POST" : "GET";
}

function priceOf(accepts: unknown): string | null {
  if (!Array.isArray(accepts)) return null;
  for (const entry of accepts) {
    const amount = zatDigits(record(entry)?.amount);
    if (amount !== null) return amount;
  }
  return null;
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
    const z402 = record(extensions?.z402);
    offers.push({
      url,
      serviceName: textOf(item.serviceName),
      method: methodOf(extensions),
      description: textOf(item.description),
      unit: textOf(z402?.unit),
      note: textOf(z402?.note),
      priceZat: priceOf(item.accepts),
    });
  }
  return offers;
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
      row = { key, name, routes: [], notes: [], health: "unknown", callsToday: null, unit: null, priceZat: null };
      rows.set(key, row);
    }
    if (row.routes.some((r) => r.url === offer.url && r.method === offer.method)) continue;
    row.routes.push({
      method: offer.method,
      path: pathOf(offer.url),
      url: offer.url,
      description: offer.description,
      unit: offer.unit,
      priceZat: offer.priceZat,
    });
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
      routes: [],
      notes: [],
      health: healthOf(entry),
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

export interface BoardSummary {
  services: number;
  up: number;
}

export function summarize(board: Board): BoardSummary {
  return {
    services: board.services.length,
    up: board.services.filter((s) => s.health === "up").length,
  };
}
