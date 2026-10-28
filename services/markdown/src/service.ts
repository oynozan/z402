/**
 * URL to markdown (design §4.2): GET /v1/markdown?url=<http(s) URL>, one page per paid call.
 *
 * The page is fetched and converted in `prepare`, before payment: a page that cannot be served is refused on the
 * client's unpaid first attempt, before any voucher exists, and is never charged. A converted page is cached by URL, so
 * the paid retry is answered from the cache and never fetches again.
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
      .then(async (page) => {
        const converted = await pool.convert(page, limits);
        const cached: CachedPage = { finalUrl: page.finalUrl, ...converted };
        cache.set(key, cached, Buffer.byteLength(cached.markdown));
        return cached;
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

    let page = cache.get(key);
    if (page === undefined) {
      let job = inflight.get(key);
      if (job === undefined) {
        const client = clientKey(req.ip ?? req.socket.remoteAddress);
        const wait = limiter.wait(client);
        if (wait > 0) {
          res.set("Retry-After", String(Math.ceil(wait / 1000)));
          res.status(429).json({ error: "rate_limited" });
          return;
        }
        if (inflight.size >= config.maxConcurrent) {
          res.set("Retry-After", "1");
          res.status(503).json({ error: "busy" });
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
              inputSchema: { properties: { url: { type: "string", format: "uri" } }, required: ["url"] },
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
