import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar } from "@x402/extensions/bazaar";
import { TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { startDiscovery, type DiscoveryHandle } from "../src/index.js";
import { echoStack } from "./support/echo.js";
import { bazaar, closeAll, deadUrl, origin, paymentRequired, router, send402, sendHealth } from "./support/origins.js";

const stacks: TestStack[] = [];
const handles: DiscoveryHandle[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await Promise.all(stacks.splice(0).map((s) => s.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeAll();
});

const quiet = (): void => undefined;
const P1 = `uregtest1${"a".repeat(60)}`;
const P2 = `uregtest1${"b".repeat(60)}`;

async function discovery(services: string[], targets: Array<{ method: "GET"; url: string }> = []): Promise<DiscoveryHandle> {
  const handle = await startDiscovery({ services, targets, port: 0, timeoutMs: 2000, log: quiet });
  handles.push(handle);
  return handle;
}

interface Listed {
  items: Array<{ resource: string; extensions?: Record<string, unknown> }>;
  pagination: { limit: number; offset: number; total: number };
  x402Version: number;
}

async function get(url: string, init?: RequestInit): Promise<{ res: Response; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { res, body: text === "" ? undefined : JSON.parse(text) };
}

/** Four routes with different offers and extensions, the last one with two offers */
async function mixed(): Promise<DiscoveryHandle> {
  const offer = (payTo: string, scheme: string, network: string) => ({ payTo, scheme, network });
  const svc = await origin(
    router({
      "GET /health": (_req, res) =>
        sendHealth(res, ["a", "b", "c", "d"].map((p) => ({ method: "GET", path: `/${p}`, unit: p })), { service: "Mixed" }),
      "GET /a": (_req, res) =>
        send402(
          res,
          paymentRequired("https://m.example/a", {
            ...offer(P1, "prepaid-voucher", "zcash:regtest"),
            extensions: { bazaar: bazaar("GET"), z402: { unit: "a" } },
          }),
        ),
      "GET /b": (_req, res) =>
        send402(res, paymentRequired("https://m.example/b", { ...offer(P2, "exact", "eip155:8453"), extensions: { bazaar: bazaar("GET") } })),
      "GET /c": (_req, res) => send402(res, paymentRequired("https://m.example/c", offer(P1, "exact", "zcash:regtest"))),
      "GET /d": (_req, res) => {
        const required = paymentRequired("https://m.example/d", offer(P1, "prepaid-voucher", "zcash:regtest"));
        (required.accepts as unknown[]).push({
          scheme: "exact",
          network: "eip155:8453",
          asset: "USDC",
          amount: "1",
          payTo: P2,
          maxTimeoutSeconds: 60,
          extra: {},
        });
        send402(res, required);
      },
    }),
  );
  return discovery([svc.url]);
}

describe("the stock Bazaar client", () => {
  test("reads the catalog of a real kit-based service unchanged", async () => {
    const svc = await echoStack();
    stacks.push(svc);
    const found = await discovery([svc.url]);

    const client = withBazaar(new HTTPFacilitatorClient({ url: found.url }));
    const listed = await client.extensions.bazaar.listResources({ type: "http" });
    expect(listed.x402Version).toBe(2);
    expect(listed.pagination).toEqual({ limit: 100, offset: 0, total: 2 });
    expect(listed.items.map((i) => i.resource)).toEqual([`${TEST_PUBLIC_URL}/v1/echo`, `${TEST_PUBLIC_URL}/v1/items/:id`]);
    expect(listed.items[0]).toMatchObject({
      type: "http",
      x402Version: 2,
      serviceName: "Echo",
      accepts: [{ scheme: "prepaid-voucher", network: "zcash:regtest", amount: "500", payTo: TEST_PAY_TO }],
    });

    const page = await client.extensions.bazaar.listResources({
      type: "http",
      payTo: TEST_PAY_TO,
      scheme: "prepaid-voucher",
      network: "zcash:regtest",
      extensions: "bazaar",
      limit: 1,
      offset: 1,
    });
    expect(page.items.map((i) => i.resource)).toEqual([`${TEST_PUBLIC_URL}/v1/items/:id`]);
    expect(page.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
    expect((await client.extensions.bazaar.listResources()).items).toHaveLength(2);
    expect((await client.extensions.bazaar.listResources({ type: "mcp" })).items).toEqual([]);
  });

  test("has no search, on purpose", async () => {
    const found = await discovery([await deadUrl()]);
    const client = withBazaar(new HTTPFacilitatorClient({ url: found.url }));
    await expect(client.extensions.bazaar.search({ query: "llm" })).rejects.toThrow(/\(404\).*not_supported/s);
  });
});

describe("GET /discovery/resources", () => {
  test("filters by type, payTo, scheme, network and extension key, all together", async () => {
    const found = await mixed();
    const names = async (query: string): Promise<string[]> => {
      const { res, body } = await get(`${found.url}/discovery/resources?${query}`);
      expect(res.status, query).toBe(200);
      return (body as Listed).items.map((i) => i.resource.slice(-1));
    };

    expect(await names("")).toEqual(["a", "b", "c", "d"]);
    expect(await names("type=http")).toEqual(["a", "b", "c", "d"]);
    expect(await names("type=mcp")).toEqual([]);
    expect(await names("type=HTTP")).toEqual([]);
    expect(await names(`payTo=${P1}`)).toEqual(["a", "c", "d"]);
    expect(await names(`payTo=${P2}`)).toEqual(["b", "d"]);
    expect(await names("payTo=nobody")).toEqual([]);
    expect(await names("scheme=exact")).toEqual(["b", "c", "d"]);
    expect(await names("network=zcash:regtest")).toEqual(["a", "c", "d"]);
    expect(await names("network=eip155:8453")).toEqual(["b", "d"]);
    expect(await names("extensions=z402")).toEqual(["a"]);
    expect(await names("extensions=bazaar")).toEqual(["a", "b"]);
    expect(await names("extensions=nope")).toEqual([]);

    // One offer has to satisfy the payment filters together, so d does not match its own P1 with exact
    expect(await names(`payTo=${P1}&scheme=exact`)).toEqual(["c"]);
    expect(await names(`payTo=${P2}&scheme=exact`)).toEqual(["b", "d"]);
    expect(await names(`payTo=${P1}&scheme=prepaid-voucher&network=zcash:regtest`)).toEqual(["a", "d"]);
    expect(await names(`extensions=bazaar&payTo=${P2}`)).toEqual(["b"]);

    // An empty filter counts as not given, and a name from the prototype is not an extension
    expect(await names("type=&payTo=&limit=&offset=")).toEqual(["a", "b", "c", "d"]);
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(await names(`extensions=${key}`), key).toEqual([]);
    }
  });

  test("pages with limit and offset, and says how many there are", async () => {
    const found = await mixed();
    const page = async (query: string): Promise<Listed> => {
      const { res, body } = await get(`${found.url}/discovery/resources?${query}`);
      expect(res.status, query).toBe(200);
      return body as Listed;
    };

    expect(await page("")).toMatchObject({ pagination: { limit: 100, offset: 0, total: 4 } });
    const second = await page("limit=2&offset=1");
    expect(second.items.map((i) => i.resource.slice(-1))).toEqual(["b", "c"]);
    expect(second.pagination).toEqual({ limit: 2, offset: 1, total: 4 });
    expect((await page("limit=2&offset=3")).items).toHaveLength(1);
    expect(await page("offset=4")).toMatchObject({ items: [], pagination: { limit: 100, offset: 4, total: 4 } });
    expect((await page("offset=999999999")).items).toEqual([]);
    expect((await page("limit=1000")).pagination.limit).toBe(1000);
    expect((await page("limit=007")).pagination.limit).toBe(7);
    expect(await page(`payTo=${P2}&limit=1`)).toMatchObject({ pagination: { limit: 1, offset: 0, total: 2 } });
  });

  test("answers 400 to a limit or an offset that is not a whole number in range", async () => {
    const found = await mixed();
    const bad: Array<[string, string]> = [
      ["limit=0", "limit: expected a whole number from 1 to 1000"],
      ["limit=1001", "limit: expected a whole number from 1 to 1000"],
      ["limit=abc", "limit: expected a whole number from 1 to 1000"],
      ["limit=-1", "limit: expected a whole number from 1 to 1000"],
      ["limit=1.5", "limit: expected a whole number from 1 to 1000"],
      ["limit=1e3", "limit: expected a whole number from 1 to 1000"],
      ["limit=%2B5", "limit: expected a whole number from 1 to 1000"],
      ["limit=%205", "limit: expected a whole number from 1 to 1000"],
      ["limit=99999999999999999999", "limit: expected a whole number from 1 to 1000"],
      ["offset=-1", "offset: expected a whole number from 0 to 999999999"],
      ["offset=x", "offset: expected a whole number from 0 to 999999999"],
      ["offset=1.0", "offset: expected a whole number from 0 to 999999999"],
      ["offset=1000000000", "offset: expected a whole number from 0 to 999999999"],
      ["limit=1&limit=2", "limit: give it once"],
      ["type=http&type=mcp", "type: give it once"],
      ["payTo=x&payTo=y", "payTo: give it once"],
    ];
    for (const [query, message] of bad) {
      const { res, body } = await get(`${found.url}/discovery/resources?${query}`);
      expect(res.status, query).toBe(400);
      expect(body, query).toEqual({ error: "bad_request", message });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("lets the browser read it from anywhere, and keeps it for five seconds", async () => {
    const found = await mixed();
    const { res } = await get(`${found.url}/discovery/resources`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("max-age=5");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();

    const status = await get(`${found.url}/discovery/status`);
    expect(status.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(status.res.headers.get("cache-control")).toBe("max-age=5");
  });

  test("answers the preflight of a browser that sends the stock client's JSON content type", async () => {
    const found = await mixed();
    const res = await fetch(`${found.url}/discovery/resources`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(await res.text()).toBe("");
  });

  test("answers HEAD like GET without a body", async () => {
    const found = await mixed();
    const res = await fetch(`${found.url}/discovery/resources`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("paging and caching", () => {
  /** `count` services of 32 routes each, which makes a list long enough to page through */
  async function crowded(count: number): Promise<DiscoveryHandle> {
    const services: string[] = [];
    for (let n = 0; n < count; n++) {
      const routes = Array.from({ length: 32 }, (_, i) => ({ method: "GET", path: `/r${i}` }));
      const table: Record<string, (req: never, res: Parameters<Parameters<typeof origin>[0]>[1]) => void> = {
        "GET /health": (_req, res) => sendHealth(res, routes),
      };
      for (const { path } of routes) table[`GET ${path}`] = (_req, res) => send402(res, paymentRequired(`https://s${n}.example${path}`));
      services.push((await origin(router(table as never))).url);
    }
    return discovery(services);
  }

  test("walks a list of 160 entries exactly once, in the same order, whatever the size of the page", async () => {
    const found = await crowded(5);
    const client = withBazaar(new HTTPFacilitatorClient({ url: found.url })).extensions.bazaar;
    const whole = await client.listResources({ type: "http", limit: 1000 });
    expect(whole.items).toHaveLength(160);
    expect(whole.pagination).toEqual({ limit: 1000, offset: 0, total: 160 });
    const order = whole.items.map((i) => i.resource);
    expect(new Set(order).size).toBe(160);

    for (const limit of [1, 7, 32, 100, 159, 160, 161]) {
      const seen: string[] = [];
      for (let offset = 0; ; offset += limit) {
        const page = await client.listResources({ type: "http", limit, offset });
        expect(page.pagination).toEqual({ limit, offset, total: 160 });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items.map((i) => i.resource));
        if (offset + limit >= page.pagination.total) break;
      }
      expect(seen, `limit ${limit}`).toEqual(order);
    }
  });

  test("returns the same list in the same order every time it is asked, and after a refresh that changes nothing", async () => {
    const found = await crowded(2);
    const ask = async (): Promise<string[]> =>
      ((await get(`${found.url}/discovery/resources?limit=1000`)).body as Listed).items.map((i) => i.resource);
    const before = await ask();
    expect(await ask()).toEqual(before);
    await found.catalog.refresh();
    expect(await ask()).toEqual(before);
  });

  test("tags the list so that a conditional request is answered 304 with the CORS header, until a refresh changes it", async () => {
    const found = await mixed();
    const first = await fetch(`${found.url}/discovery/resources`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    await first.arrayBuffer();

    // cache: "no-cache" keeps fetch from adding the Cache-Control: no-cache that it adds to a revalidation by default
    const conditional = { headers: { "if-none-match": etag ?? "" }, cache: "no-cache" } as const;
    const again = await fetch(`${found.url}/discovery/resources`, conditional);
    expect(again.status).toBe(304);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect(again.headers.get("cache-control")).toBe("max-age=5");
    expect(await again.text()).toBe("");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await found.catalog.refresh();
    const changed = await fetch(`${found.url}/discovery/resources`, conditional);
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();
  });

  test("answers a limit and an offset past the end with an empty page that still counts the matches", async () => {
    const found = await mixed();
    const page = async (query: string): Promise<Listed> => ((await get(`${found.url}/discovery/resources?${query}`)).body as Listed);
    expect(await page(`payTo=${P2}&offset=2`)).toMatchObject({ items: [], pagination: { limit: 100, offset: 2, total: 2 } });
    expect(await page("type=mcp&limit=1000&offset=999999999")).toMatchObject({ items: [], pagination: { limit: 1000, offset: 999999999, total: 0 } });
    expect(await page("limit=1&offset=3")).toMatchObject({ pagination: { limit: 1, offset: 3, total: 4 } });
  });
});

describe("the other endpoints", () => {
  test("GET /discovery/status lists each service", async () => {
    const found = await mixed();
    const { res, body } = await get(`${found.url}/discovery/status`);
    expect(res.status).toBe(200);
    expect(body).toEqual([
      {
        serviceName: "Mixed",
        url: "https://m.example",
        up: true,
        ready: true,
        latencyMs: expect.any(Number),
        checkedAt: expect.any(String),
        callsToday: 0,
        unit: "a",
        priceZat: "500",
      },
    ]);
  });

  test("GET /health says how many items there are", async () => {
    const found = await mixed();
    const empty = await discovery([await deadUrl()]);
    expect((await get(`${found.url}/health`)).body).toEqual({ ok: true, items: 4 });
    expect((await get(`${empty.url}/health`)).body).toEqual({ ok: true, items: 0 });
    expect((await get(`${found.url}/health`)).res.headers.get("cache-control")).toBe("no-store");
  });

  test("GET /discovery/search is a 404 on purpose", async () => {
    const found = await mixed();
    const { res, body } = await get(`${found.url}/discovery/search?query=llm`);
    expect(res.status).toBe(404);
    expect(body).toEqual({
      error: "not_supported",
      message: "There is no search: pull the list and match on your own machine.",
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("everything else is a JSON 404", async () => {
    const found = await mixed();
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/", undefined],
      ["/discovery", undefined],
      ["/discovery/resources/x", undefined],
      ["/discovery/unknown", undefined],
      ["/v1/generate", undefined],
      ["/discovery/resources", { method: "POST", body: "{}" }],
      ["/discovery/status", { method: "DELETE" }],
      ["/health", { method: "PUT" }],
    ];
    for (const [path, init] of cases) {
      const { res, body } = await get(`${found.url}${path}`, init);
      expect(res.status, `${init?.method ?? "GET"} ${path}`).toBe(404);
      expect(body).toEqual({ error: "not_found" });
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });

  test("an unexpected failure is a JSON 500 that is logged, and the next request is served", async () => {
    let broken = true;
    const lines: string[] = [];
    const app = createApp(
      {
        size: 0,
        list() {
          if (broken) throw new Error("boom\nforged line");
          return { x402Version: 2, items: [], pagination: { limit: 100, offset: 0, total: 0 } };
        },
        status: () => [],
      },
      { log: (line) => lines.push(line) },
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const failed = await get(`${url}/discovery/resources`);
    expect(failed.res.status).toBe(500);
    expect(failed.body).toEqual({ error: "internal_error" });
    expect(failed.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(lines).toEqual(["GET /discovery/resources failed (boom forged line)"]);

    broken = false;
    expect((await get(`${url}/discovery/resources`)).res.status).toBe(200);
  });
});
