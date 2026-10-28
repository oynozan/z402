/**
 * What discovery asks of a service. A probe answers with a result and never throws. It has its own deadline, which also
 * covers reading the body, and it reads at most 64 KiB, so a service that hangs, trickles or lies can only fail its own
 * probe. Redirects are not followed and a route is only ever probed on the service's own origin. What a 402 says is kept
 * only when it is small, shallow and printable: the catalog serves it to every agent and every page that asks.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import {
  isValidServiceName,
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import { isProbeMethod, type ProbeMethod } from "./config.js";

export const USER_AGENT = "z402-discovery";
/** The header the service kit recognises, so a probe skips the route's own checks and gets its 402 */
export const PROBE_HEADER = "X-Z402-Probe";
export const MAX_HEALTH_BYTES = 64 * 1024;
/** The most routes read from one service */
export const MAX_ROUTES = 32;

const X402_VERSION = 2;
const MAX_HEADER_CHARS = 64 * 1024;
const MAX_PATH_CHARS = 2048;
const MAX_UNIT_CHARS = 64;
const MAX_REASON_CHARS = 200;
const MAX_CAUSES = 5;
/** More than any starter service offers, and fewer than a header can hold */
const MAX_ACCEPTS = 32;
/** The payment requirements are level 1. A declaration needs a dozen, JSON.stringify with an indent fails at thousands */
const MAX_DEPTH = 64;
const MAX_URL_CHARS = 2048;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_MIME_CHARS = 128;
const REQUIREMENT_FIELDS = ["scheme", "network", "asset", "amount", "payTo"] as const;

/** A slash, then visible ASCII except # and backslash */
const PROBE_PATH_RE = /^\/[!"$-\[\]-~]*$/;
/** Characters that end a line or act on a terminal, such as controls, bidi overrides and zero-width spaces, but not the joiners */
const CONTROL_RE = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** What no URL has: controls, format characters, lone surrogates and every kind of space */
const UNSAFE_URL_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u;
/** An encoded dot, slash or backslash, which can turn into a path segment boundary after a check */
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c)/i;
/** Printable ASCII, with spaces only between visible characters */
const MIME_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const PRICE_RE = /^[0-9]{1,30}$/;
/** The error codes of Node's HTTP client that a service can cause, and what to tell the operator instead of the code */
const ERROR_TEXT: ReadonlyMap<string, string> = new Map([
  ["UND_ERR_HEADERS_OVERFLOW", "response headers are larger than Node accepts (16 KiB)"],
]);

export interface HealthRoute {
  method: ProbeMethod;
  path: string;
  probePath?: string;
  unit: string | null;
}

export interface Health {
  ready: boolean;
  service: string | null;
  callsToday: number | null;
  priceZat: string | null;
  routes: HealthRoute[];
}

/** What a 402 says about one route, already checked and cleaned */
export interface ProbedRoute {
  url: string;
  accepts: PaymentRequirements[];
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
}

export type HealthProbe = { ok: true; health: Health; latencyMs: number } | { ok: false; reason: string };
export type RouteProbe = { ok: true; route: ProbedRoute; latencyMs: number } | { ok: false; reason: string };

export interface ProbeContext {
  /** Each request gets this long, body included */
  timeoutMs: number;
  /** Aborts every request at once, for shutdown */
  signal?: AbortSignal;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** One line of printable text, so that nothing a service sends can forge a log line */
function clean(value: string, max = MAX_REASON_CHARS): string {
  const flat = value.replace(CONTROL_RE, " ").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  // A high surrogate at the cut has lost its pair
  return `${/[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head}...`;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason: clean(reason) };
}

/** A non-empty string cleaned to one line, else null */
function label(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const value = clean(x, max);
  return value === "" ? null : value;
}

function nameOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "name" in e && typeof e.name === "string" ? e.name : undefined;
}

/** The first error code down the chain of causes, such as ECONNREFUSED, and the message of the deepest cause */
function rootOf(e: unknown): { code?: string; message: string } {
  let message = e instanceof Error ? e.message : String(e);
  let current: unknown = e;
  for (let depth = 0; depth < MAX_CAUSES && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") return { code: current.code, message };
    if (current instanceof Error && current.message !== "") message = current.message;
    current = "cause" in current ? current.cause : undefined;
  }
  return { message };
}

/** A short reason for a failed request, fit for a log line */
export function describeError(e: unknown): string {
  const name = nameOf(e);
  if (name === "TimeoutError") return "timed out";
  if (name === "AbortError") return "aborted";
  const { code, message } = rootOf(e);
  const text = code === undefined ? undefined : ERROR_TEXT.get(code);
  return clean(text ?? code ?? (message === "" ? (name ?? "error") : message));
}

/** Runs `run` with a signal that aborts after the deadline or when the context's signal does, and clears both after */
async function withDeadline<T>(ctx: ProbeContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ctx.timeoutMs);
  const stop = (): void => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted === true) stop();
  else ctx.signal?.addEventListener("abort", stop, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", stop);
  }
}

/** Frees the connection of a response whose body is not needed */
function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/** The body as text, or undefined when it is larger than `max` bytes */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    discard(res);
    return undefined;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isProbePath(x: unknown): x is string {
  return typeof x === "string" && x.length <= MAX_PATH_CHARS && PROBE_PATH_RE.test(x);
}

function healthRoute(x: unknown): HealthRoute | undefined {
  if (!isRecord(x)) return undefined;
  const method = typeof x.method === "string" ? x.method.toUpperCase() : "";
  const { path, probePath } = x;
  if (!isProbeMethod(method) || !isProbePath(path)) return undefined;
  if (probePath !== undefined && !isProbePath(probePath)) return undefined;
  return { method, path, ...(probePath !== undefined && { probePath }), unit: label(x.unit, MAX_UNIT_CHARS) };
}

/** Reads what the service kit's /health says, keeping only what is well formed */
function readHealth(status: number, body: string): Health | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "/health is not JSON";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.routes)) return "/health is not a z402 service health";
  const routes: HealthRoute[] = [];
  for (const entry of parsed.routes) {
    if (routes.length >= MAX_ROUTES) break;
    const route = healthRoute(entry);
    if (route !== undefined) routes.push(route);
  }
  const service = typeof parsed.service === "string" ? parsed.service : undefined;
  return {
    ready: status === 200 && parsed.ready !== false,
    service: isValidServiceName(service) ? service : null,
    callsToday: count(parsed.callsToday),
    priceZat: typeof parsed.priceZat === "string" && PRICE_RE.test(parsed.priceZat) ? parsed.priceZat : null,
    routes,
  };
}

/** A whole number of zero or more, else null */
function count(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;
}

/** GET {base}/health, where 200 and 503 both mean the service is up */
export async function probeHealth(base: string, ctx: ProbeContext): Promise<HealthProbe> {
  const started = performance.now();
  try {
    return await withDeadline(ctx, async (signal): Promise<HealthProbe> => {
      const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
      const res = await fetch(`${base}/health`, { method: "GET", headers, redirect: "manual", signal });
      if (res.status !== 200 && res.status !== 503) {
        discard(res);
        return fail(`/health answered HTTP ${res.status}`);
      }
      const body = await readCapped(res, MAX_HEALTH_BYTES);
      if (body === undefined) return fail(`/health is larger than ${MAX_HEALTH_BYTES / 1024} KiB`);
      const health = readHealth(res.status, body);
      if (typeof health === "string") return fail(health);
      return { ok: true, health, latencyMs: performance.now() - started };
    });
  } catch (e) {
    return fail(describeError(e));
  }
}

/**
 * The URL a route is probed at, or undefined when it would leave the service's own origin or the path it is served
 * under. Services can share an origin behind a gateway, and a service must not be able to make discovery send a request
 * to its neighbour, whatever method and `..` it lists. An encoded slash or dot is refused too, since a gateway may decode
 * it after the check.
 */
export function routeUrl(base: string, route: HealthRoute): string | undefined {
  const path = route.probePath ?? route.path;
  if (ENCODED_TRAVERSAL_RE.test(path)) return undefined;
  try {
    const root = new URL(base);
    const url = new URL(`${base}${path}`);
    if (url.origin !== root.origin) return undefined;
    const prefix = root.pathname.replace(/\/+$/, "");
    return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The paths, as a URL writes them, that the resource URL of a route's 402 may end in: the route's own and its probe path */
export function routePaths(route: HealthRoute): string[] {
  const paths = [route.path, ...(route.probePath === undefined ? [] : [route.probePath])];
  return paths.map((path) => pathnameOf(`http://z402.invalid${path}`) ?? path);
}

/** The path of a URL as the URL parser writes it, or undefined for text that is not a URL */
export function pathnameOf(url: string): string | undefined {
  return URL.canParse(url) ? new URL(url).pathname : undefined;
}

/**
 * Why a 402 does not describe the route that was probed, or undefined when it does. A resource URL that ends in another
 * path would list this route's terms under the URL of a different one, and push that one out of the catalog.
 */
export function checkResourcePath(resourceUrl: string, paths: readonly string[]): string | undefined {
  const actual = pathnameOf(resourceUrl) ?? "";
  if (paths.length === 0 || paths.some((path) => actual.endsWith(path))) return undefined;
  return clean(`PAYMENT-REQUIRED resource.url does not end in the path that was probed, ${paths[0] ?? ""}`);
}

/** Whether `value` holds objects or arrays nested deeper than `max`, found level by level so that nothing recurses */
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

/** An entry a client can act on has these five strings, and the rest of it is passed through as received */
function isRequirement(x: unknown): x is PaymentRequirements {
  return isRecord(x) && REQUIREMENT_FIELDS.every((field) => typeof x[field] === "string" && x[field] !== "");
}

/** A media type such as application/json, or undefined for anything else, since it only describes the answer */
function mediaType(x: unknown): string | undefined {
  return typeof x === "string" && x.length <= MAX_MIME_CHARS && MIME_RE.test(x) ? x : undefined;
}

function isHttpUrl(x: unknown): x is string {
  if (typeof x !== "string" || x.length > MAX_URL_CHARS || UNSAFE_URL_RE.test(x) || !URL.canParse(x)) return false;
  const url = new URL(x);
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
}

/** Decodes the PAYMENT-REQUIRED header of a 402 into a route, or says why it is unusable */
function readPaymentRequired(header: string): ProbedRoute | string {
  if (header.length > MAX_HEADER_CHARS) return "PAYMENT-REQUIRED is too large";
  let raw: unknown;
  try {
    raw = decodePaymentRequiredHeader(header);
  } catch {
    return "PAYMENT-REQUIRED is not base64 JSON";
  }
  if (!isRecord(raw) || raw.x402Version !== X402_VERSION) return `PAYMENT-REQUIRED is not x402Version ${X402_VERSION}`;
  if (nestsDeeperThan(raw, MAX_DEPTH)) return `PAYMENT-REQUIRED is nested deeper than ${MAX_DEPTH} levels`;
  const accepts = Array.isArray(raw.accepts) ? raw.accepts.filter(isRequirement).slice(0, MAX_ACCEPTS) : [];
  if (accepts.length === 0) return "PAYMENT-REQUIRED has no usable accepts entry";
  const resource = raw.resource;
  if (!isRecord(resource) || !isHttpUrl(resource.url)) return "PAYMENT-REQUIRED resource.url is not an http(s) URL";

  const extensions = isRecord(raw.extensions) ? raw.extensions : undefined;
  const bazaar = extensions?.bazaar;
  if (bazaar !== undefined) {
    const verdict = isRecord(bazaar)
      ? validateDiscoveryExtensionSpec(bazaar)
      : { valid: false, errors: ["not an object"] };
    if (!verdict.valid) return `bazaar extension is invalid (${verdict.errors?.join(", ") ?? "no reason given"})`;
  }

  const url = resource.url;
  const meta = sanitizeResourceServiceMetadata({
    url,
    serviceName: resource.serviceName,
    tags: resource.tags,
    iconUrl: resource.iconUrl,
  } as ResourceInfo);
  const description = label(resource.description, MAX_DESCRIPTION_CHARS) ?? undefined;
  const mimeType = mediaType(resource.mimeType);
  return {
    url,
    accepts,
    ...(description !== undefined && { description }),
    ...(mimeType !== undefined && { mimeType }),
    ...meta,
    ...(extensions !== undefined && { extensions }),
  };
}

/** An unpaid request with the route's method and no body, which a service answers with its 402 */
export async function probeRoute(method: ProbeMethod, url: string, ctx: ProbeContext): Promise<RouteProbe> {
  const started = performance.now();
  try {
    return await withDeadline(ctx, async (signal): Promise<RouteProbe> => {
      const headers = { Accept: "application/json", "User-Agent": USER_AGENT, [PROBE_HEADER]: "1" };
      const res = await fetch(url, { method, headers, redirect: "manual", signal });
      const header = res.headers.get("payment-required");
      discard(res);
      if (res.status !== 402) return fail(`HTTP ${res.status}, expected 402`);
      if (header === null) return fail("402 without a PAYMENT-REQUIRED header");
      const route = readPaymentRequired(header);
      if (typeof route === "string") return fail(route);
      return { ok: true, route, latencyMs: performance.now() - started };
    });
  } catch (e) {
    return fail(describeError(e));
  }
}
