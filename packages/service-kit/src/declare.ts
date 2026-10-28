/**
 * The declaration heartbeat (multi-provider design §4.4, "Sources" 1): a ready service lists its paid routes in the
 * facilitator's Bazaar with POST /discovery/resources, at once and then every 30 s, which is also how the catalog tells
 * that it is up. Each item is read from the 402 an unpaid request to its route gets from the same x402 server, so the
 * catalog offers exactly what the route asks for. One bad item refuses a whole call, so the facilitator's limits on an
 * item are checked at start.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { HTTPAdapter, HTTPRequestContext, x402HTTPResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";

/** A Bazaar DiscoveryResource without lastUpdated, which the facilitator keeps itself */
export interface DeclaredResource {
  resource: string;
  type: "http";
  x402Version: number;
  accepts: PaymentRequirements[];
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
}

/** What the facilitator takes in one item (design §4.4, "Item validation") */
export const MAX_URL_CHARS = 2048;
export const MAX_DESCRIPTION_CHARS = 512;
export const MAX_MIME_TYPE_CHARS = 128;
export const MAX_EXTENSIONS_BYTES = 8192;
/** The items one provider may list, so no one service may have more routes */
export const MAX_ROUTES = 128;
const MAX_ITEMS_PER_CALL = 32;
/** Under the facilitator's 64 KB limit on a request body */
const MAX_BODY_BYTES = 60 * 1024;
const EMPTY_BODY_BYTES = '{"items":[]}'.length;
/** How soon a service that is not ready asks again, so that its first declaration follows soon after it is */
const NOT_READY_RECHECK_MS = 5_000;
/** The facilitator answers a declaration from memory, so one that takes longer counts as not reached this time */
const DECLARE_TIMEOUT_MS = 10_000;
const MAX_LOGGED_CHARS = 200;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

/** An unpaid request for `path`, as the payment middleware hands one to the x402 server */
function unpaidRequest(method: string, path: string): HTTPRequestContext {
  const adapter: HTTPAdapter = {
    getHeader: () => undefined,
    getMethod: () => method,
    getPath: () => path,
    getUrl: () => path,
    getAcceptHeader: () => "",
    getUserAgent: () => "",
  };
  return { adapter, path, method };
}

/**
 * The 402's extensions with the path parameters the route declares in place of the ones the server read from the
 * request's URL, while the method and route template it adds to every 402 stay
 */
function withDeclaredPathParams(extensions: Json, declared: unknown): Json {
  const bazaar = record(extensions["bazaar"]);
  const info = record(bazaar?.["info"]);
  const input = record(info?.["input"]);
  if (bazaar === undefined || info === undefined || input === undefined || !Object.hasOwn(input, "pathParams")) {
    return extensions;
  }
  const own = record(record(record(declared)?.["info"])?.["input"])?.["pathParams"];
  const { pathParams: _fromRequest, ...rest } = input;
  return {
    ...extensions,
    bazaar: { ...bazaar, info: { ...info, input: own === undefined ? rest : { ...input, pathParams: own } } },
  };
}

/**
 * The catalog item of one route, read from the 402 of an unpaid request to it. `declared` is the route's own bazaar
 * extension, whose example path parameters replace those of the request.
 */
export async function declaredResource(
  http: x402HTTPResourceServer,
  route: { method: string; path: string; probePath?: string },
  declared: unknown,
): Promise<DeclaredResource> {
  const path = route.probePath ?? route.path;
  const result = await http.processHTTPRequest(unpaidRequest(route.method, path));
  const header = result.type === "payment-error" ? result.response.headers["PAYMENT-REQUIRED"] : undefined;
  if (header === undefined) throw new Error(`routes: an unpaid ${route.method} ${path} gets no 402 to declare`);
  const { x402Version, resource, accepts, extensions } = decodePaymentRequiredHeader(header);
  return {
    resource: resource.url,
    type: "http",
    x402Version,
    accepts,
    ...(resource.description !== undefined && resource.description !== "" && { description: resource.description }),
    ...(resource.mimeType !== undefined && resource.mimeType !== "" && { mimeType: resource.mimeType }),
    ...(resource.serviceName !== undefined && { serviceName: resource.serviceName }),
    ...(resource.tags !== undefined && { tags: resource.tags }),
    ...(extensions !== undefined && { extensions: withDeclaredPathParams(extensions, declared) }),
  };
}

/** The items as request bodies, in order, each with at most 32 items and within the facilitator's body limit */
export function declarationBodies(items: readonly DeclaredResource[]): string[] {
  const bodies: string[] = [];
  let batch: string[] = [];
  let bytes = EMPTY_BODY_BYTES;
  const flush = (): void => {
    if (batch.length > 0) bodies.push(`{"items":[${batch.join(",")}]}`);
    batch = [];
    bytes = EMPTY_BODY_BYTES;
  };
  for (const item of items) {
    const json = JSON.stringify(item);
    // One more byte for the comma before it
    const size = Buffer.byteLength(json) + 1;
    if (batch.length === MAX_ITEMS_PER_CALL || bytes + size > MAX_BODY_BYTES) flush();
    batch.push(json);
    bytes += size;
  }
  flush();
  return bodies;
}

/** The URL without a user or password, which the log may show */
function shownUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  return shown.href.replace(/\/+$/, "");
}

/** Text from the facilitator cut to one short line of printable ASCII, with the token taken out should it echo it */
function printable(text: string, token: string | undefined): string {
  const scrubbed = token === undefined ? text : text.replaceAll(token, "<token>");
  return scrubbed.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, MAX_LOGGED_CHARS);
}

function reasonOf(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return `no answer within ${DECLARE_TIMEOUT_MS / 1000} s`;
  const cause = e instanceof Error ? e.cause : undefined;
  if (cause instanceof Error) return (cause as NodeJS.ErrnoException).code ?? cause.message;
  return e instanceof Error ? e.message : String(e);
}

/** What the facilitator said about the item it refused, as its 400 names it */
async function refusedItem(res: Response, token: string | undefined): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return "";
  }
  const { error, index, message } = record(body) ?? {};
  const where = typeof index === "number" ? `item ${index}: ` : "";
  const what = typeof message === "string" ? message : typeof error === "string" ? error : "";
  return what === "" ? "" : printable(`${where}${what}`, token);
}

export interface DeclareOptions {
  facilitatorUrl: string;
  token: string | undefined;
  bodies: readonly string[];
  /** How many routes the bodies list, which the log line of a success gives */
  routes: number;
  ready: () => Promise<boolean>;
  intervalMs: number;
  log: (message: string) => void;
}

export interface Declaring {
  /** Stops at once, ending a declaration in flight, and resolves once nothing runs any more */
  stop(): Promise<void>;
}

/**
 * Declares the routes while the service is ready: at once, then every `intervalMs` after the last declaration ended,
 * so two never overlap. A failure is logged once until the outcome changes, never stops the service, and is tried
 * again at the next beat.
 */
export function startDeclaring(o: DeclareOptions): Declaring {
  const endpoint = `${o.facilitatorUrl}/discovery/resources`;
  const at = `the facilitator at ${shownUrl(o.facilitatorUrl)}`;
  const again = `trying again every ${o.intervalMs / 1000} s`;
  const headers = {
    "content-type": "application/json",
    ...(o.token !== undefined && { authorization: `Bearer ${o.token}` }),
  };
  const stopping = new AbortController();
  let outcome: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let beat: Promise<void> | undefined;

  const report = (next: string, message: string): void => {
    if (next !== outcome) o.log(`discovery: ${message}`);
    outcome = next;
  };

  const refused = async (res: Response): Promise<string> => {
    if (res.status === 400) {
      const detail = await refusedItem(res, o.token);
      return `${at} refused the declaration (400${detail === "" ? "" : `, ${detail}`})`;
    }
    await res.body?.cancel();
    if (res.status === 404) return `${at} has no Bazaar to declare to (404), so the routes are not listed`;
    if (res.status === 401 || res.status === 403) {
      return `Z402_FACILITATOR_TOKEN: ${at} refused the declaration (${res.status})`;
    }
    return `${at} answered the declaration with ${res.status}`;
  };

  // One request at a time, each body after the one before was taken
  const declare = async (): Promise<void> => {
    for (const body of o.bodies) {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(DECLARE_TIMEOUT_MS)]),
        });
      } catch (e) {
        if (!stopping.signal.aborted) report("unreachable", `cannot reach ${at} (${reasonOf(e)}); ${again}`);
        return;
      }
      if (res.status !== 200) {
        const why = await refused(res).catch(() => `${at} answered the declaration with ${res.status}`);
        if (!stopping.signal.aborted) report(`status ${res.status}`, `${why}; ${again}`);
        return;
      }
      await res.body?.cancel();
    }
    const routes = `${o.routes} paid route${o.routes === 1 ? "" : "s"}`;
    report("listed", `${routes} listed by ${at}, declared again every ${o.intervalMs / 1000} s`);
  };

  const tick = async (): Promise<boolean> => {
    if (!(await o.ready())) return false;
    if (!stopping.signal.aborted) await declare();
    return true;
  };
  const run = (): void => {
    beat = tick().then(
      (ready) => schedule(ready ? o.intervalMs : Math.min(o.intervalMs, NOT_READY_RECHECK_MS)),
      () => schedule(o.intervalMs),
    );
  };
  const schedule = (ms: number): void => {
    if (stopping.signal.aborted) return;
    timer = setTimeout(run, ms);
    // A beat that is due never holds the process open
    timer.unref();
  };
  run();

  return {
    stop: async () => {
      stopping.abort();
      clearTimeout(timer);
      await beat;
    },
  };
}
