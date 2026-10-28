/**
 * Fetches one page (design §4.2) on node:http and node:https rather than fetch(), so that each connection is pinned:
 * the socket's lookup answers with the addresses the guard allowed and nothing else, which makes DNS rebinding between
 * the check and the connection impossible. Redirects are followed by hand and every hop goes through the guard again.
 * One deadline covers the whole chain, and the body is capped as received and again after decompression.
 */
import type { LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, inflateRaw } from "node:zlib";
import { PageError } from "./errors.js";
import {
  allowedAddresses,
  checkRedirect,
  hostOf,
  isPublicAddress,
  parsePageUrl,
  portOf,
  systemResolver,
  type AddressPolicy,
  type Resolver,
} from "./guard.js";

export interface FetchOptions {
  allowedPorts: ReadonlySet<number>;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
  /** Which addresses may be connected to. Default isPublicAddress; only tests relax it */
  policy?: AddressPolicy;
  /** Default dns.lookup with all addresses */
  resolver?: Resolver;
}

export interface FetchedPage {
  /** Where the body came from, after redirects, without a fragment */
  finalUrl: string;
  status: number;
  /** The media type without parameters, lower case */
  contentType: string;
  /** The charset parameter of Content-Type, lower case */
  charset: string | undefined;
  /** Decompressed */
  body: Buffer;
}

export const PAGE_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9";
const ACCEPT_ENCODING = "gzip, deflate, br";
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliAsync = promisify(brotliDecompress);

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Rejects with the signal's reason once it aborts; the DNS lookup itself cannot be cancelled */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A socket lookup that answers with the checked addresses whatever name it is asked for */
function pinned(addresses: readonly LookupAddress[]): LookupFunction {
  const first = addresses[0];
  if (first === undefined) throw new PageError("fetch_failed", "no address to connect to");
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, addresses.map((a) => ({ ...a })));
    else callback(null, first.address, first.family);
  };
}

function get(
  url: URL,
  addresses: readonly LookupAddress[],
  userAgent: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const host = hostOf(url);
  const secure = url.protocol === "https:";
  const options: RequestOptions = {
    host,
    port: portOf(url),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    // Fixed headers only: no cookies and nothing of the caller's request
    headers: { "User-Agent": userAgent, Accept: ACCEPT, "Accept-Encoding": ACCEPT_ENCODING },
    // A fresh agent per request: no pooled socket and no proxy taken from the environment
    agent: false,
    lookup: pinned(addresses),
    signal,
    ...(secure && isIP(host) === 0 && { servername: host.replace(/\.$/, "") }),
  };
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(options);
    req.once("response", resolve);
    req.on("error", reject);
    req.end();
  });
}

function nextHop(location: string, from: URL, allowedPorts: ReadonlySet<number>): URL {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch (e) {
    throw new PageError("fetch_failed", "the redirect has an invalid Location", { cause: e });
  }
  return checkRedirect(next, allowedPorts);
}

function parseContentType(header: string | undefined): { mediaType: string; charset: string | undefined } {
  const [type = "", ...params] = (header ?? "").split(";");
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== "charset") continue;
    const value = param
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim()
      .toLowerCase();
    return { mediaType: type.trim().toLowerCase(), charset: value === "" ? undefined : value };
  }
  return { mediaType: type.trim().toLowerCase(), charset: undefined };
}

/** The single content coding of a response, "" for none; a stacked or unknown one is refused */
function codingOf(header: string | undefined): string {
  const codings = (header ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "" && c !== "identity");
  const [coding = ""] = codings;
  if (codings.length > 1 || !["", "gzip", "x-gzip", "deflate", "br"].includes(coding)) {
    throw new PageError("fetch_failed", `unsupported Content-Encoding ${header ?? ""}`);
  }
  return coding;
}

async function readCapped(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new PageError("too_large", `the body is over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** RFC 9110 deflate is zlib-wrapped, but some servers send raw deflate, which browsers accept too */
function isZlibWrapped(raw: Buffer): boolean {
  const cmf = raw[0] ?? 0;
  const flg = raw[1] ?? 0;
  return (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
}

/** zlib stops as soon as its output passes maxOutputLength, so a decompression bomb costs at most maxBytes */
async function decompress(raw: Buffer, coding: string, maxBytes: number): Promise<Buffer> {
  if (coding === "" || raw.length === 0) return raw;
  const options = { maxOutputLength: maxBytes };
  try {
    if (coding === "br") return await brotliAsync(raw, options);
    if (coding === "deflate") return await (isZlibWrapped(raw) ? inflateAsync : inflateRawAsync)(raw, options);
    return await gunzipAsync(raw, options);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new PageError("too_large", `the body is over ${maxBytes} bytes once decompressed`);
    }
    throw new PageError("fetch_failed", `cannot decode the ${coding} body (${text(e)})`, { cause: e });
  }
}

async function readPage(url: URL, status: number, res: IncomingMessage, maxBytes: number): Promise<FetchedPage> {
  try {
    const { mediaType, charset } = parseContentType(res.headers["content-type"]);
    if (!PAGE_TYPES.has(mediaType)) {
      throw new PageError("unsupported_content_type", `${mediaType || "no content type"} is not a page`);
    }
    if (Number(res.headers["content-length"]) > maxBytes) {
      throw new PageError("too_large", `the body is over ${maxBytes} bytes`);
    }
    const coding = codingOf(res.headers["content-encoding"]);
    const body = await decompress(await readCapped(res, maxBytes), coding, maxBytes);
    const finalUrl = new URL(url);
    finalUrl.hash = "";
    return { finalUrl: finalUrl.href, status, contentType: mediaType, charset, body };
  } finally {
    res.destroy();
  }
}

/**
 * GETs a page and every redirect it leads to, each hop checked by the guard first. Failures are PageErrors: a refused
 * URL or address, a body that is too large or not a page, an upstream error status (kept in upstreamStatus), a network
 * failure or the deadline.
 */
export async function safeFetch(input: string | URL, o: FetchOptions): Promise<FetchedPage> {
  const policy = o.policy ?? isPublicAddress;
  const resolver = o.resolver ?? systemResolver;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), o.timeoutMs);
  try {
    let url = parsePageUrl(typeof input === "string" ? input : input.href, o.allowedPorts);
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await untilAborted(allowedAddresses(url, policy, resolver), deadline.signal);
      const res = await get(url, addresses, o.userAgent, deadline.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location !== undefined) {
        res.destroy();
        if (redirects >= o.maxRedirects) throw new PageError("fetch_failed", `more than ${o.maxRedirects} redirects`);
        url = nextHop(location, url, o.allowedPorts);
        continue;
      }
      if (status < 200 || status > 299) {
        res.destroy();
        throw new PageError("fetch_failed", `the upstream answered ${status}`, { upstreamStatus: status });
      }
      return await readPage(url, status, res, o.maxBytes);
    }
  } catch (e) {
    if (e instanceof PageError) throw e;
    if (deadline.signal.aborted) throw new PageError("fetch_timeout", `no complete answer within ${o.timeoutMs} ms`);
    throw new PageError("fetch_failed", text(e), { cause: e });
  } finally {
    clearTimeout(timer);
  }
}
