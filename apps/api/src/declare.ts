/**
 * The declaration heartbeat of the API (multi-provider design §4.4, "Sources" 1), which the service kit runs in the
 * same way for its routes (packages/service-kit/src/declare.ts). With a public URL set, GET /chunk is listed in the
 * facilitator's Bazaar with POST /discovery/resources, at once and then every 30 s, and that beat is also how the
 * catalog tells that the API is up. The item is read from the 402 that an unpaid request to the route gets from the
 * same x402 server, so the catalog offers exactly what the route asks for. One bad item refuses a whole call, so the
 * one limit that the facilitator puts on the URL is checked at start.
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

/** The one route of the API, which the 402 names and the Bazaar lists */
export const CHUNK_PATH = "/chunk";
/** The heartbeat the facilitator's catalog reads liveness from */
export const DECLARE_INTERVAL_MS = 30_000;
/** The longest resource URL the facilitator's catalog takes */
const MAX_URL_CHARS = 2048;
/** The facilitator answers a declaration from memory, so one that takes longer counts as not reached this time */
const DECLARE_TIMEOUT_MS = 10_000;
const MAX_LOGGED_CHARS = 200;
const AUTHORITY = /^https?:\/\/([^/?#]*)/i;
const NOT_IN_A_URL = /[\x00-\x20\x7f\\]/;
const NOT_A_URL = "expected an http:// or https:// URL";

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

/** Why `url` cannot be where this API is reached, or undefined when the catalog takes the resource made from it */
export function publicUrlProblem(url: unknown): string | undefined {
  if (typeof url !== "string") return NOT_A_URL;
  const authority = AUTHORITY.exec(url)?.[1];
  // The URL parser forgives a backslash, an empty userinfo and stray whitespace, none of which the catalog takes
  if (authority === undefined || authority === "" || NOT_IN_A_URL.test(url) || !URL.canParse(url)) return NOT_A_URL;
  if (authority.includes("@")) return "must not carry credentials";
  if (url.includes("?") || url.includes("#")) return "must not have a query or a fragment";
  if (url.replace(/\/+$/, "").length + CHUNK_PATH.length > MAX_URL_CHARS) {
    return `with ${CHUNK_PATH} it makes a resource URL over ${MAX_URL_CHARS} characters`;
  }
  return undefined;
}

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

/** The catalog item of a route, read from the 402 of an unpaid request to it */
export async function declaredResource(
  http: x402HTTPResourceServer,
  route: { method: string; path: string },
): Promise<DeclaredResource> {
  const result = await http.processHTTPRequest(unpaidRequest(route.method, route.path));
  const header = result.type === "payment-error" ? result.response.headers["PAYMENT-REQUIRED"] : undefined;
  if (header === undefined) {
    throw new Error(`discovery: an unpaid ${route.method} ${route.path} gets no 402 to declare`);
  }
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
    ...(extensions !== undefined && { extensions }),
  };
}

/** The URL as the log may show it, without a user, a password, a query or a fragment */
function shownUrl(url: string): string {
  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  shown.search = "";
  shown.hash = "";
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
  /** Already checked to be an http(s) URL without credentials */
  facilitatorUrl: string;
  token: string | undefined;
  item: DeclaredResource;
  intervalMs: number;
  log: (message: string) => void;
}

export interface Declaring {
  /** Stops at once, ending a declaration in flight, and resolves once nothing runs any more */
  stop(): Promise<void>;
}

/** Declares the item at once and then an interval after each declaration ended, logging each change of outcome once */
export function startDeclaring(o: DeclareOptions): Declaring {
  const endpoint = `${o.facilitatorUrl.replace(/\/+$/, "")}/discovery/resources`;
  const at = `the facilitator at ${shownUrl(o.facilitatorUrl)}`;
  const every = `${o.intervalMs / 1000} s`;
  const again = `trying again every ${every}`;
  const body = JSON.stringify({ items: [o.item] });
  const headers = {
    "content-type": "application/json",
    ...(o.token !== undefined && { authorization: `Bearer ${o.token}` }),
  };
  const stopping = new AbortController();
  let outcome: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let beat: Promise<void> | undefined;

  const report = (next: string, message: string): void => {
    if (stopping.signal.aborted) return;
    if (next !== outcome) o.log(`discovery: ${message}`);
    outcome = next;
  };

  const refused = async (res: Response): Promise<string> => {
    if (res.status === 400) {
      const detail = await refusedItem(res, o.token);
      return `${at} refused the declaration (400${detail === "" ? "" : `, ${detail}`})`;
    }
    await res.body?.cancel();
    if (res.status === 404) return `${at} has no Bazaar to declare to (404), so the route is not listed`;
    if (res.status === 401 || res.status === 403) {
      return `Z402_FACILITATOR_TOKEN: ${at} refused the declaration (${res.status})`;
    }
    return `${at} answered the declaration with ${res.status}`;
  };

  const declare = async (): Promise<void> => {
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
      const reason = printable(reasonOf(e), o.token);
      report(`error ${reason}`, `cannot reach ${at} (${reason}); ${again}`);
      return;
    }
    if (res.status !== 200) {
      const why = await refused(res).catch(() => `${at} answered the declaration with ${res.status}`);
      report(`status ${res.status}`, `${why}; ${again}`);
      return;
    }
    await res.body?.cancel();
    report("listed", `1 paid route listed by ${at}, declared again every ${every}`);
  };

  const schedule = (): void => {
    if (stopping.signal.aborted) return;
    timer = setTimeout(run, o.intervalMs);
    // A beat that is due never holds the process open
    timer.unref();
  };
  const run = (): void => {
    // Whether it ended well or not, the next one follows an interval later
    beat = declare().then(schedule, schedule);
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
