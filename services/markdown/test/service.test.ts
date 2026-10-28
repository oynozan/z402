import type { LookupAddress } from "node:dns";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import {
  startTestStack,
  TEST_NETWORK,
  TEST_PAY_TO,
  TEST_PUBLIC_URL,
  type TestStack,
} from "@z402/service-kit/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadMarkdownConfig, type MarkdownConfig } from "../src/config.js";
import { safeFetch } from "../src/fetch.js";
import type { Resolver } from "../src/guard.js";
import { createMarkdownService, type Fetcher, type MarkdownAnswer } from "../src/service.js";
import { allowLoopback, html, startPages, type PageServer } from "./pages.js";

const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c.close();
});

const ARTICLE = `<html><head><title>Paid Article</title></head><body><nav>Menu</nav><article>
  <h2>Section</h2><p>${"Words worth paying for. ".repeat(30)}<a href="/next">Next</a></p></article></body></html>`;

const fakeDns: Resolver = async (hostname) => {
  if (hostname !== "internal.test") {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  }
  return [{ address: "10.0.0.7", family: 4 } satisfies LookupAddress];
};

interface Harness {
  stack: TestStack;
  pages: PageServer;
  /** Every URL the service fetched */
  fetches: string[];
  /** The service URL for a page of the test server */
  at(path: string): string;
}

async function harness(
  o: { config?: Partial<MarkdownConfig>; wrap?: (fetcher: Fetcher) => Fetcher; now?: () => number } = {},
): Promise<Harness> {
  const pages = await startPages({
    "/article": html(ARTICLE),
    "/other": html(ARTICLE),
    "/third": html(ARTICLE),
    "/json": html("{}", "application/json"),
    "/big": html(`<p>${"x".repeat(8192)}</p>`),
    "/hang": () => undefined,
    "/switch": (req) => {
      req.socket.end("HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: z402\r\n\r\n");
    },
    "/to-metadata": (_req, res) => {
      res.writeHead(302, { location: `http://169.254.169.254:${pages.port}/latest/meta-data/` }).end();
    },
  });
  closers.push(pages);
  const config: MarkdownConfig = { ...loadMarkdownConfig({}), allowedPorts: new Set([pages.port]), ...o.config };
  const fetches: string[] = [];
  const fetcher: Fetcher = (url) => {
    fetches.push(url);
    return safeFetch(url, { ...config, policy: allowLoopback, resolver: fakeDns });
  };
  const stack = await startTestStack({
    build: async (env) => {
      const fetching = o.wrap?.(fetcher) ?? fetcher;
      const service = await createMarkdownService({ env, config, fetcher: fetching, ...(o.now && { now: o.now }) });
      return { app: service.app, close: service.close };
    },
  });
  closers.push(stack);
  return {
    stack,
    pages,
    fetches,
    at: (path) => `${stack.url}/v1/markdown?url=${encodeURIComponent(`${pages.origin}${path}`)}`,
  };
}

/** The stock paying fetch, running `between` after the unpaid attempt's 402 and before the paid retry */
function payingWith(h: Harness, between: () => Promise<void>): typeof fetch {
  let pending: (() => Promise<void>) | undefined = between;
  const unpaidFirst: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const run = pending;
    if (res.status === 402 && run !== undefined) {
      pending = undefined;
      await run();
    }
    return res;
  };
  return wrapFetchWithPayment(unpaidFirst, new x402Client().register(TEST_NETWORK, h.stack.scheme));
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe("GET /v1/markdown", { timeout: 30_000 }, () => {
  test("the unpaid attempt fetches the page and gets the 402, and the paid retry comes from the cache", async () => {
    const h = await harness();
    const unpaid = await fetch(h.at("/article"));
    expect(unpaid.status).toBe(402);
    expect(h.fetches).toEqual([`${h.pages.origin}/article`]);

    const paid = await h.stack.paidFetch(h.at("/article"));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    const answer = (await paid.json()) as MarkdownAnswer;
    expect(answer).toMatchObject({
      url: `${h.pages.origin}/article`,
      finalUrl: `${h.pages.origin}/article`,
      title: "Paid Article",
      byline: null,
      truncated: false,
    });
    expect(answer.markdown).toMatch(/^## Section\n\nWords worth paying for\./);
    expect(answer.markdown).toContain(`[Next](${h.pages.origin}/next)`);
    expect(answer.markdown).not.toContain("Menu");
    expect(answer.length).toBe(answer.markdown.length);
    // The paying client's own unpaid attempt and its paid retry were both cache hits
    expect(h.fetches).toHaveLength(1);
    expect(h.pages.hits.filter((path) => path === "/article")).toHaveLength(1);

    // A page nobody asked for yet: the unpaid attempt fetches it and the paid retry does not
    const fresh = await h.stack.paidFetch(h.at("/other"));
    expect(fresh.status).toBe(200);
    expect(h.fetches).toEqual([`${h.pages.origin}/article`, `${h.pages.origin}/other`]);
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(1000n);
    expect(await (await fetch(`${h.stack.url}/health`)).json()).toMatchObject({ ready: true, callsToday: 2 });
  });

  test("a page that cannot be served is refused on the unpaid attempt, before any voucher exists", async () => {
    const h = await harness({ config: { maxBytes: 4096, timeoutMs: 1_000 } });
    const service = `${h.stack.url}/v1/markdown`;
    const ask = (url: string): string => `${service}?url=${encodeURIComponent(url)}`;
    const cases: Array<[string, number, object]> = [
      [h.at("/missing"), 502, { error: "fetch_failed", upstreamStatus: 404 }],
      [h.at("/json"), 415, { error: "unsupported_content_type" }],
      [h.at("/big"), 413, { error: "too_large" }],
      [h.at("/hang"), 504, { error: "fetch_timeout" }],
      [h.at("/to-metadata"), 403, { error: "blocked_address" }],
      [ask(`http://internal.test:${h.pages.port}/`), 403, { error: "blocked_address" }],
      [ask(`http://127.0.0.2:${h.pages.port}/`), 403, { error: "blocked_address" }],
      [ask(`http://nowhere.test:${h.pages.port}/`), 502, { error: "fetch_failed" }],
      [service, 400, { error: "invalid_url" }],
      [ask("ftp://example.com/"), 400, { error: "invalid_url" }],
      [ask(`http://u:p@127.0.0.1:${h.pages.port}/article`), 400, { error: "invalid_url" }],
      [ask("http://127.0.0.1:22/"), 400, { error: "invalid_url" }],
      [`${service}?url=a&url=b`, 400, { error: "invalid_url" }],
    ];
    for (const [url, status, body] of cases) {
      const res = await h.stack.paidFetch(url);
      expect(res.status, url).toBe(status);
      expect(await res.json(), url).toEqual(body);
    }
    expect(h.stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
    expect(await (await fetch(`${h.stack.url}/health`)).json()).toMatchObject({ callsToday: 0 });
  });

  test("a page answered to an unpaid attempt is kept for its paid retry, whatever other clients ask", async () => {
    const h = await harness({ config: { cacheEntries: 1, trustProxy: "loopback" } });
    let other: Response | undefined;
    const paid = await payingWith(h, async () => {
      other = await fetch(h.at("/other"), { headers: { "x-forwarded-for": "198.51.100.7" } });
    })(h.at("/article"));
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as MarkdownAnswer).title).toBe("Paid Article");
    // The paid retry was answered from the page fetched for the unpaid attempt, never fetched again
    expect(h.fetches).toEqual([`${h.pages.origin}/article`]);
    // The other client's page found no room, and was refused before anyone paid for it
    expect(other?.status).toBe(503);
    expect(await other?.json()).toEqual({ error: "busy" });
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(500n);
  });

  test("a page that finds the cache full of held pages once fetched is refused before payment", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const h = await harness({
      config: { cacheEntries: 1, trustProxy: "loopback" },
      wrap: (fetcher) => async (url) => {
        started.push(url);
        if (url.endsWith("/other")) await gate;
        return fetcher(url);
      },
    });
    const other = fetch(h.at("/other"), { headers: { "x-forwarded-for": "198.51.100.7" } });
    await until(() => started.length === 1);
    // While that one is on its way, this page takes the only place and is held for this client's paid retry
    expect((await fetch(h.at("/article"))).status).toBe(402);
    release();
    const refused = await other;
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "busy" });
    const paid = await h.stack.paidFetch(h.at("/article"));
    expect(paid.status).toBe(200);
    // Each page was fetched once, and the paid retry came from the cache
    expect(h.fetches).toEqual([`${h.pages.origin}/article`, `${h.pages.origin}/other`]);
  });

  test("a page about to expire is still there for the paid retry of an unpaid attempt it answered", async () => {
    let now = 1_000_000;
    const h = await harness({ config: { cacheMs: 1_000 }, now: () => now });
    expect((await fetch(h.at("/article"))).status).toBe(402);
    now += 999;
    const paid = await payingWith(h, async () => {
      now += 600;
    })(h.at("/article"));
    expect(paid.status).toBe(200);
    expect(h.fetches).toEqual([`${h.pages.origin}/article`]);
    // An unpaid attempt now finds it stale and fetches it again
    expect((await fetch(h.at("/article"))).status).toBe(402);
    expect(h.fetches).toHaveLength(2);
  });

  test("the rate limit refuses a fetch before payment, but never a cached page", async () => {
    const h = await harness({ config: { ratePerMin: 2 } });
    expect((await fetch(h.at("/article"))).status).toBe(402);
    expect((await fetch(h.at("/other"))).status).toBe(402);
    const limited = await fetch(h.at("/third"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(29);
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    const paidLimited = await h.stack.paidFetch(h.at("/third"));
    expect(paidLimited.status).toBe(429);
    expect(h.stack.scheme.session(TEST_PAY_TO)).toBeUndefined();

    // A cached page costs no token, so an unpaid attempt and its paid retry go through with the bucket empty
    const paid = await h.stack.paidFetch(h.at("/other"));
    expect(paid.status).toBe(200);
    expect(h.fetches).toHaveLength(2);
  });

  test("the rate limit counts the socket address unless MARKDOWN_TRUST_PROXY names the proxy", async () => {
    const direct = await harness({ config: { ratePerMin: 1 } });
    const as = (ip: string): RequestInit => ({ headers: { "x-forwarded-for": ip } });
    expect((await fetch(direct.at("/article"), as("198.51.100.1"))).status).toBe(402);
    expect((await fetch(direct.at("/other"), as("198.51.100.2"))).status).toBe(429);

    const proxied = await harness({ config: { ratePerMin: 1, trustProxy: "loopback" } });
    expect((await fetch(proxied.at("/article"), as("198.51.100.1"))).status).toBe(402);
    expect((await fetch(proxied.at("/other"), as("198.51.100.2"))).status).toBe(402);
    expect((await fetch(proxied.at("/third"), as("198.51.100.2"))).status).toBe(429);
  });

  test("past MARKDOWN_MAX_CONCURRENT fetches the answer is busy, and the same URL joins its fetch", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const h = await harness({
      config: { maxConcurrent: 1 },
      wrap: (fetcher) => async (url) => {
        started.push(url);
        await gate;
        return fetcher(url);
      },
    });
    const first = fetch(h.at("/article"));
    await until(() => started.length === 1);
    const joined = fetch(h.at("/article"));
    const busy = await fetch(h.at("/other"));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toEqual({ error: "busy" });
    release();
    expect((await first).status).toBe(402);
    expect((await joined).status).toBe(402);
    expect(started).toEqual([`${h.pages.origin}/article`]);
  });

  test("a page that answers 101 is refused and gives its fetch slot back", async () => {
    const h = await harness({ config: { maxConcurrent: 1, timeoutMs: 1_000 } });
    const answer = await Promise.race([
      fetch(h.at("/switch")),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000)),
    ]);
    expect(answer).not.toBe("hung");
    expect((answer as Response).status).toBe(502);
    expect(await (answer as Response).json()).toEqual({ error: "fetch_failed" });
    // With the only slot back, the next page is fetched instead of refused as busy
    expect((await fetch(h.at("/article"))).status).toBe(402);
  });

  test("/health is ready, and a discovery probe gets the 402 without fetching anything", async () => {
    const h = await harness();
    const health = await fetch(`${h.stack.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      ready: true,
      service: "URL to markdown",
      priceZat: "500",
      routes: [{ method: "GET", path: "/v1/markdown", unit: "page" }],
    });

    const probe = await fetch(`${h.stack.url}/v1/markdown`, { headers: { "x-z402-probe": "1" } });
    expect(probe.status).toBe(402);
    expect(h.fetches).toEqual([]);
    const header = probe.headers.get("payment-required") ?? "";
    const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      resource: object;
      extensions: { z402: object; bazaar: { info: { input: object } } };
    };
    expect(required.resource).toMatchObject({
      url: `${TEST_PUBLIC_URL}/v1/markdown`,
      serviceName: "URL to markdown",
      tags: ["web", "markdown", "scrape"],
    });
    expect(required.extensions.z402).toEqual({ unit: "page", note: "The site sees this server's IP, not yours." });
    expect(required.extensions.bazaar.info.input).toEqual({
      type: "http",
      method: "GET",
      queryParams: { url: "https://example.com" },
    });
  });

  test("the input schema uses only keywords the Bazaar validator knows, so a start logs no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = await harness();
      const probe = await fetch(`${h.stack.url}/v1/markdown`, { headers: { "x-z402-probe": "1" } });
      const header = probe.headers.get("payment-required") ?? "";
      type Schema = { properties: Record<string, Schema> };
      const required = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        extensions: { bazaar: { schema: Schema } };
      };
      const params = required.extensions.bazaar.schema.properties["input"]?.properties["queryParams"]?.properties;
      expect(params).toEqual({ url: { type: "string", pattern: "^https?://" } });
      expect(warn.mock.calls.filter(([m]) => /unknown format/.test(String(m)))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("HEAD must pay too, and a wrong method is refused before payment", async () => {
    const h = await harness();
    expect((await fetch(h.at("/article"), { method: "HEAD" })).status).toBe(402);
    const post = await fetch(h.at("/article"), { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
