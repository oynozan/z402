/**
 * URL to markdown (design §4.2): GET /v1/markdown?url=<http(s) URL>, one page per paid call.
 *
 * The page is fetched and converted in `prepare`, before payment: a page that cannot be served is refused on the
 * client's unpaid first attempt, before any voucher exists, and is never charged. A converted page is cached by URL and
 * held there for the paid retry of every unpaid attempt it answered, so that retry is answered from the cache and never
 * fetches again; other clients' pages cannot push it out, and a page that finds no room is refused as busy instead.
 *
 * The rate limit counts fetches, not requests: only a cache miss takes a token from the caller's bucket, so an unpaid
 * attempt and its paid retry cost one token, and a paid retry is never refused for the rate limit. A miss that joins a
 * fetch of the same URL already in flight takes no token either.
 */
import { createPaidService, type PaidService, type ServiceEnv } from "@z402/service-kit";
import type { Express, NextFunction, Request, Response } from "express";
import type { MarkdownConfig } from "./config.js";
import { maxTagsFor, type ConvertLimits, type Converted } from "./convert.js";
import { ConvertPool } from "./convert-pool.js";
import { PageError } from "./errors.js";
import { safeFetch, type FetchedPage } from "./fetch.js";
import { parsePageUrl, type Resolver } from "./guard.js";
import { clientKey, PageCache, RateLimiter } from "./limits.js";

export const MARKDOWN_PATH = "/v1/markdown";

/** Fetches one page; every redirect it follows must go through the SSRF guard */
export type Fetcher = (url: string) => Promise<FetchedPage>;

export interface MarkdownServiceOptions {
  env: ServiceEnv;
  config: MarkdownConfig;
  /** Default safeFetch with the strict address policy */
  fetcher?: Fetcher;
  /** DNS for the default fetcher */
  resolver?: Resolver;
  /** Clock of the rate limit and the cache */
  now?: () => number;
}

export interface MarkdownService {
  app: Express;
  stats: PaidService["stats"];
  close(): Promise<void>;
}

export interface MarkdownAnswer {
  /** The URL asked for */
  url: string;
  /** Where the page came from, after redirects */
  finalUrl: string;
  title: string | null;
  byline: string | null;
  markdown: string;
  /** Characters in markdown */
  length: number;
  /** The page had more than the answer holds (MARKDOWN_MAX_MARKDOWN_BYTES) */
  truncated: boolean;
}

interface CachedPage extends Converted {
  finalUrl: string;
}

const ANSWER = "markdownAnswer";

const EXAMPLE_MARKDOWN =
  "This domain is for use in documentation examples without needing permission. Avoid use in operations.\n\n" +
  "[Learn more](https://iana.org/domains/example)";
const EXAMPLE: MarkdownAnswer = {
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  title: "Example Domain",
  byline: null,
  markdown: EXAMPLE_MARKDOWN,
  length: EXAMPLE_MARKDOWN.length,
  truncated: false,
};

function busy(res: Response): void {
  res.set("Retry-After", "1");
  res.status(503).json({ error: "busy" });
}

/** A paid retry carries one of these; an unpaid attempt neither */
function carriesPayment(req: Request): boolean {
  return req.get("payment-signature") !== undefined || req.get("x-payment") !== undefined;
}

/** What a cached page keeps in memory, in UTF-8 bytes */
function entryBytes(key: string, page: CachedPage): number {
  const strings = [key, page.finalUrl, page.markdown, page.title ?? "", page.byline ?? ""];
  return strings.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
}

function refuse(res: Response, e: unknown): void {
  if (e instanceof PageError) {
    res.status(e.status).json(e.body());
    return;
  }
  console.error(`markdown: page failed unexpectedly (${e instanceof Error ? e.message : String(e)})`);
  res.status(502).json({ error: "convert_failed" });
}

export async function createMarkdownService(o: MarkdownServiceOptions): Promise<MarkdownService> {
  const { config } = o;
  const now = o.now ?? Date.now;
  const fetcher: Fetcher = o.fetcher ?? ((url) => safeFetch(url, { ...config, resolver: o.resolver }));
  const cache = new PageCache<CachedPage>({
    ttlMs: config.cacheMs,
    max: config.cacheEntries,
    maxBytes: config.cacheBytes,
    now,
  });
  const limiter = new RateLimiter(config.ratePerMin, now);
  const inflight = new Map<string, Promise<CachedPage>>();
  // Fewer workers than fetches: a fetched page waits for a worker, and the memory of conversions stays bounded
  const pool = new ConvertPool({
    size: config.convertWorkers,
    timeoutMs: config.timeoutMs,
    memoryMb: config.workerHeapMb,
  });
  const limits: ConvertLimits = {
    maxMarkdownBytes: config.maxMarkdownBytes,
    maxTags: maxTagsFor(config.workerHeapMb),
  };

  const load = (key: string): Promise<CachedPage> => {
    const job: Promise<CachedPage> = Promise.resolve()
      .then(() => fetcher(key))
      .then(async (fetched) => {
        const converted = await pool.convert(fetched, limits);
        const page: CachedPage = { finalUrl: fetched.finalUrl, ...converted };
        // Not stored when it does not fit next to the held pages, which an unpaid attempt then finds below
        cache.set(key, page, entryBytes(key, page));
        return page;
      })
      .finally(() => {
        if (inflight.get(key) === job) inflight.delete(key);
      });
    inflight.set(key, job);
    return job;
  };

  const prepare = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.query["url"];
    let url: URL;
    try {
      url = parsePageUrl(typeof raw === "string" ? raw : "", config.allowedPorts);
    } catch (e) {
      refuse(res, e);
      return;
    }
    const keyUrl = new URL(url);
    keyUrl.hash = "";
    const key = keyUrl.href;

    // A paid request may be answered from a page held past its freshness for the unpaid attempt it retries
    const paid = carriesPayment(req);
    const client = clientKey(req.ip ?? req.socket.remoteAddress);
    let page = paid ? cache.getPaid(key) : cache.get(key);
    if (page === undefined) {
      let job = inflight.get(key);
      if (job === undefined) {
        const wait = limiter.wait(client);
        if (wait > 0) {
          res.set("Retry-After", String(Math.ceil(wait / 1000)));
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        // An unpaid attempt needs room in the cache for its paid retry; a paid request is answered from its fetch
        if (inflight.size >= config.maxConcurrent || (!paid && !cache.hasRoom(key))) {
          busy(res);
          return;
        }
        limiter.take(client);
        job = load(key);
      }
      try {
        page = await job;
      } catch (e) {
        refuse(res, e);
        return;
      }
    }
    if (!paid) {
      // Its paid retry is answered from the cache, so the page must be there now, and is held for it
      page = cache.get(key);
      if (page === undefined) {
        busy(res);
        return;
      }
      cache.hold(key, client);
    }
    const answer: MarkdownAnswer = {
      url: url.href,
      finalUrl: page.finalUrl,
      title: page.title,
      byline: page.byline,
      markdown: page.markdown,
      length: page.markdown.length,
      truncated: page.truncated,
    };
    res.locals[ANSWER] = answer;
    next();
  };

  await pool.warm();
  let service: PaidService;
  try {
    service = await createPaidService({
      env: o.env,
      service: {
        serviceName: "URL to markdown",
        tags: ["web", "markdown", "scrape"],
        routes: [
          {
            method: "GET",
            path: MARKDOWN_PATH,
            description: "Fetches one public web page and returns its main content as clean markdown.",
            unit: "page",
            note: "The site sees this server's IP, not yours.",
            discovery: {
              input: { url: "https://example.com" },
              // A pattern, as the Bazaar validator knows no format "uri" and warns about it at every start
              inputSchema: { properties: { url: { type: "string", pattern: "^https?://" } }, required: ["url"] },
              output: { example: EXAMPLE },
            },
            prepare: [prepare],
          },
        ],
      },
    });
  } catch (e) {
    await pool.close();
    throw e;
  }

  const { app } = service;
  app.set("trust proxy", config.trustProxy);
  // Runs only after the payment middleware has verified the voucher, and only ever after prepare stored the answer
  app.get(MARKDOWN_PATH, (_req, res) => {
    const answer = res.locals[ANSWER] as MarkdownAnswer | undefined;
    if (answer === undefined) {
      res.status(500).json({ error: "internal" });
      return;
    }
    res.json(answer);
  });
  return { app, stats: service.stats, close: () => pool.close() };
}
