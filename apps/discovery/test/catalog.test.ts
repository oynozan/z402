import { TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Catalog, type CatalogOptions } from "../src/catalog.js";
import { echoStack, post } from "./support/echo.js";
import {
  bazaar,
  closeAll,
  deadUrl,
  hangingOrigin,
  origin,
  paymentRequired,
  pathOf,
  router,
  send402,
  send402Raw,
  sendHealth,
  sendJson,
  type Handler,
  type HealthRouteSpec,
} from "./support/origins.js";

const stacks: TestStack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.close()));
  await closeAll();
});

async function stack(o: { ready?: () => boolean } = {}): Promise<TestStack> {
  const s = await echoStack(o);
  stacks.push(s);
  return s;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const quiet = (): void => undefined;

function catalogOf(o: Partial<CatalogOptions> & Pick<CatalogOptions, "services">): Catalog {
  return new Catalog({ timeoutMs: 2000, log: quiet, ...o });
}

function bazaarMethod(item: { extensions?: Record<string, unknown> } | undefined): unknown {
  const ext = item?.extensions?.bazaar as { info: { input: { method: unknown } } } | undefined;
  return ext?.info.input.method;
}

describe("a kit-based service", () => {
  test("is listed route by route, as its own 402 declares it", async () => {
    const svc = await stack();
    const catalog = catalogOf({ services: [svc.url] });
    const before = Date.now();
    await catalog.refresh();
    const after = Date.now();

    const { items, pagination, x402Version } = catalog.list();
    expect(x402Version).toBe(2);
    expect(pagination).toEqual({ limit: 100, offset: 0, total: 2 });
    expect(items.map((i) => i.resource)).toEqual([`${TEST_PUBLIC_URL}/v1/echo`, `${TEST_PUBLIC_URL}/v1/items/:id`]);

    const [echo, item] = items;
    expect(echo).toMatchObject({
      type: "http",
      x402Version: 2,
      description: "Echoes text back",
      mimeType: "application/json",
      serviceName: "Echo",
      tags: ["test"],
    });
    expect(echo?.accepts).toHaveLength(1);
    expect(echo?.accepts[0]).toMatchObject({
      scheme: "prepaid-voucher",
      network: "zcash:regtest",
      amount: "500",
      asset: "ZEC",
      payTo: TEST_PAY_TO,
    });
    expect(echo?.lastUpdated).toMatch(ISO);
    expect(Date.parse(echo?.lastUpdated ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(echo?.lastUpdated ?? "")).toBeLessThanOrEqual(after);
    expect(echo).not.toHaveProperty("iconUrl");

    expect(bazaarMethod(echo)).toBe("POST");
    expect(bazaarMethod(item)).toBe("GET");
    expect(echo?.extensions?.z402).toEqual({ unit: "echo", note: "Test note" });
    expect(item?.extensions?.z402).toEqual({ unit: "item" });
    expect(item?.extensions?.bazaar).toMatchObject({ routeTemplate: "/v1/items/:id" });
  });

  test("is probed for free, and the probe skips the checks that would refuse its empty body", async () => {
    const svc = await stack();
    const catalog = catalogOf({ services: [svc.url] });
    await catalog.refresh();
    await catalog.refresh();

    const refused = await fetch(`${svc.url}/v1/echo`, { method: "POST" });
    expect(refused.status).toBe(400);
    expect(catalog.list().pagination.total).toBe(2);
    expect(svc.scheme.session(TEST_PAY_TO)).toBeUndefined();
    expect((await (await fetch(`${svc.url}/health`)).json()) as { callsToday: number }).toMatchObject({ callsToday: 0 });
  });

  test("reports its status, with the calls it has served", async () => {
    const svc = await stack();
    const catalog = catalogOf({ services: [svc.url] });
    expect(catalog.status()).toEqual([
      {
        serviceName: null,
        url: null,
        up: false,
        ready: false,
        latencyMs: null,
        checkedAt: null,
        callsToday: null,
        unit: null,
        priceZat: null,
      },
    ]);

    await catalog.refresh();
    expect(catalog.status()).toEqual([
      {
        serviceName: "Echo",
        url: TEST_PUBLIC_URL,
        up: true,
        ready: true,
        latencyMs: expect.any(Number),
        checkedAt: expect.stringMatching(ISO),
        callsToday: 0,
        unit: "echo",
        priceZat: "500",
      },
    ]);

    const paid = await svc.paidFetch(`${svc.url}/v1/echo`, post({ text: "hi" }));
    expect(paid.status).toBe(200);
    await catalog.refresh();
    expect(catalog.status()[0]).toMatchObject({ up: true, callsToday: 1 });
  });

  test("that is not ready is up, not ready and not listed", async () => {
    const svc = await stack({ ready: () => false });
    const catalog = catalogOf({ services: [svc.url] });
    await catalog.refresh();
    expect(catalog.status()[0]).toMatchObject({ serviceName: "Echo", up: true, ready: false, unit: "echo" });
    expect(catalog.list().items).toEqual([]);
  });

  test("that is down is reported down and lists nothing", async () => {
    const catalog = catalogOf({ services: [await deadUrl()] });
    await catalog.refresh();
    expect(catalog.list()).toEqual({ x402Version: 2, items: [], pagination: { limit: 100, offset: 0, total: 0 } });
    expect(catalog.status()).toEqual([
      {
        serviceName: null,
        url: null,
        up: false,
        ready: false,
        latencyMs: null,
        checkedAt: expect.stringMatching(ISO),
        callsToday: null,
        unit: null,
        priceZat: null,
      },
    ]);
  });

  test("that goes down after a good probe keeps its items with their old lastUpdated", async () => {
    const svc = await stack();
    const catalog = catalogOf({ services: [svc.url] });
    await catalog.refresh();
    const good = catalog.list().items;
    const checked = catalog.status()[0]?.checkedAt;
    expect(good).toHaveLength(2);

    await svc.close();
    await catalog.refresh();

    expect(catalog.list().items).toEqual(good);
    expect(catalog.status()[0]).toMatchObject({
      serviceName: "Echo",
      url: TEST_PUBLIC_URL,
      up: false,
      ready: false,
      latencyMs: null,
      callsToday: null,
      unit: "echo",
      priceZat: "500",
    });
    expect(catalog.status()[0]?.checkedAt).not.toBe(checked);
  });
});

/** A service whose health and routes the test changes while the catalog watches */
function mutable(initial: HealthRouteSpec[], respond?: (path: string) => Handler | undefined) {
  const state = { routes: initial, ready: true, down: false };
  const handler: Handler = (req, res) => {
    const path = pathOf(req);
    if (state.down) {
      sendJson(res, 500, { error: "boom" });
      return;
    }
    if (path === "/health") {
      sendHealth(res, state.routes, { ready: state.ready });
      return;
    }
    const custom = respond?.(path);
    if (custom !== undefined) {
      custom(req, res);
      return;
    }
    if (state.routes.some((r) => r.path === path)) send402(res, paymentRequired(`https://svc.example${path}`));
    else sendJson(res, 404, { error: "not_found" });
  };
  return { state, handler };
}

describe("the catalog over time", () => {
  test("drops a route the service stops listing, but keeps one that only fails its probe", async () => {
    const failing = new Set<string>();
    const svc = mutable([{ method: "GET", path: "/a" }, { method: "GET", path: "/b" }], (path) =>
      failing.has(path) ? (_req, res) => sendJson(res, 500, {}) : undefined,
    );
    const o = await origin(svc.handler);
    const catalog = catalogOf({ services: [o.url] });

    await catalog.refresh();
    const first = catalog.list().items;
    expect(first.map((i) => i.resource)).toEqual(["https://svc.example/a", "https://svc.example/b"]);

    failing.add("/b");
    await catalog.refresh();
    const kept = catalog.list().items;
    expect(kept.map((i) => i.resource)).toEqual(["https://svc.example/a", "https://svc.example/b"]);
    expect(kept[1]).toEqual(first[1]);

    svc.state.routes = [{ method: "GET", path: "/a" }];
    await catalog.refresh();
    expect(catalog.list().items.map((i) => i.resource)).toEqual(["https://svc.example/a"]);
  });

  test("a route that answers again is listed again, and a service that comes back is up", async () => {
    const svc = mutable([{ method: "GET", path: "/a" }]);
    svc.state.down = true;
    const o = await origin(svc.handler);
    const catalog = catalogOf({ services: [o.url] });

    await catalog.refresh();
    expect(catalog.status()[0]).toMatchObject({ up: false });
    expect(catalog.size).toBe(0);

    svc.state.down = false;
    await catalog.refresh();
    expect(catalog.status()[0]).toMatchObject({ up: true, ready: true, serviceName: "Fake", url: "https://svc.example" });
    expect(catalog.size).toBe(1);
  });

  test("a service that was ready and no longer is stays listed, and shows as not ready", async () => {
    const svc = mutable([{ method: "GET", path: "/a" }], (path) =>
      !svc.state.ready && path === "/a" ? (_req, res) => sendJson(res, 503, { error: "not_ready" }) : undefined,
    );
    const o = await origin(svc.handler);
    const catalog = catalogOf({ services: [o.url] });
    await catalog.refresh();
    const good = catalog.list().items;

    svc.state.ready = false;
    await catalog.refresh();
    expect(catalog.status()[0]).toMatchObject({ up: true, ready: false });
    expect(catalog.list().items).toEqual(good);
  });

  test("lists services in the order of the configuration and routes in the order of the service", async () => {
    const a = await origin(
      router({
        "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/z" }, { method: "GET", path: "/y" }], { service: "A" }),
        "GET /z": (_req, res) => send402(res, paymentRequired("https://a.example/z", { serviceName: "A" })),
        "GET /y": (_req, res) => send402(res, paymentRequired("https://a.example/y", { serviceName: "A" })),
      }),
    );
    const b = await origin(
      router({
        "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/x" }], { service: "B" }),
        "GET /x": (_req, res) => send402(res, paymentRequired("https://b.example/x", { serviceName: "B" })),
      }),
    );
    const catalog = catalogOf({ services: [b.url, a.url] });
    for (let round = 0; round < 3; round++) {
      await catalog.refresh();
      expect(catalog.list().items.map((i) => i.resource)).toEqual([
        "https://b.example/x",
        "https://a.example/z",
        "https://a.example/y",
      ]);
    }
    expect(catalog.status().map((s) => s.serviceName)).toEqual(["B", "A"]);
  });

  test("lists one item for one method and resource, whoever declares it", async () => {
    const same = router({
      "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/x" }, { method: "POST", path: "/x" }]),
      "GET /x": (_req, res) => send402(res, paymentRequired("https://svc.example/x", { description: "get" })),
      "POST /x": (_req, res) => send402(res, paymentRequired("https://svc.example/x", { description: "post" })),
    });
    const one = await origin(same);
    const two = await origin(same);
    const catalog = catalogOf({
      services: [one.url, two.url],
      targets: [{ method: "GET", url: `${two.url}/x` }],
    });
    await catalog.refresh();
    expect(catalog.list().items.map((i) => i.description)).toEqual(["get", "post"]);
  });
});

describe("targets", () => {
  test("get only the route probe, and are listed after the services", async () => {
    const api = await origin(
      router({
        "GET /chunk": (_req, res) => send402(res, paymentRequired("https://api.example/chunk", { serviceName: "Api" })),
        "POST /broken": (_req, res) => sendJson(res, 500, {}),
      }),
    );
    const svc = await origin(
      router({
        "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/a" }]),
        "GET /a": (_req, res) => send402(res, paymentRequired("https://svc.example/a")),
      }),
    );
    const catalog = catalogOf({
      services: [svc.url],
      targets: [
        { method: "GET", url: `${api.url}/chunk` },
        { method: "POST", url: `${api.url}/broken` },
        { method: "GET", url: `${api.url}/missing` },
      ],
    });
    await catalog.refresh();

    expect(catalog.list().items.map((i) => i.resource)).toEqual(["https://svc.example/a", "https://api.example/chunk"]);
    expect(catalog.list().items[1]).not.toHaveProperty("extensions");
    expect([...api.requests].sort()).toEqual(["GET /chunk", "GET /missing", "POST /broken"]);
    expect(svc.requests).toContain("GET /health");
    expect(catalog.status()).toHaveLength(1);
  });

  test("a target alone is enough, and one that fails keeps its last good item", async () => {
    let answer: Handler = (_req, res) => send402(res, paymentRequired("https://api.example/chunk"));
    const api = await origin((req, res) => answer(req, res));
    const catalog = catalogOf({ services: [], targets: [{ method: "GET", url: `${api.url}/chunk` }] });
    await catalog.refresh();
    const good = catalog.list().items;
    expect(good).toHaveLength(1);

    answer = (_req, res) => sendJson(res, 500, {});
    await catalog.refresh();
    expect(catalog.list().items).toEqual(good);
    expect(catalog.status()).toEqual([]);
  });
});

describe("a service that misbehaves", () => {
  test("a hanging one times out without holding the others back", async () => {
    const hang = await hangingOrigin();
    const svc = await stack();
    const catalog = catalogOf({ services: [hang.url, svc.url], timeoutMs: 1000 });

    const started = performance.now();
    const refreshing = catalog.refresh();
    await vi.waitFor(() => expect(catalog.size).toBe(2), { timeout: 900, interval: 5 });
    expect(catalog.status()[0]?.checkedAt).toBeNull();

    await refreshing;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(catalog.status().map((s) => s.up)).toEqual([false, true]);
    expect(catalog.status()[0]?.checkedAt).toMatch(ISO);
  });

  test("a route that hangs only costs its own item", async () => {
    const svc = await origin(
      router({
        "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/a" }, { method: "GET", path: "/slow" }]),
        "GET /a": (_req, res) => send402(res, paymentRequired("https://svc.example/a")),
        "GET /slow": () => undefined,
      }),
    );
    const catalog = catalogOf({ services: [svc.url], timeoutMs: 400 });
    const started = performance.now();
    await catalog.refresh();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(catalog.list().items.map((i) => i.resource)).toEqual(["https://svc.example/a"]);
    expect(catalog.status()[0]).toMatchObject({ up: true, ready: true });
  });

  test("a health that is too big, not JSON or answered by a redirect marks the service down", async () => {
    const big = await origin((_req, res) => sendJson(res, 200, { routes: [], pad: "x".repeat(70_000) }));
    const text = await origin((_req, res) => res.end("<html>"));
    const moved = await origin(
      router({
        "GET /health": (_req, res) => {
          res.writeHead(302, { location: "/elsewhere" });
          res.end();
        },
        "GET /elsewhere": (_req, res) => sendHealth(res, []),
      }),
    );
    const catalog = catalogOf({ services: [big.url, text.url, moved.url] });
    await catalog.refresh();
    expect(catalog.status().map((s) => s.up)).toEqual([false, false, false]);
    expect(moved.requests).toEqual(["GET /health"]);
  });

  test("a route list that points outside the service is not followed", async () => {
    const victim = await origin(() => undefined);
    const svc = await origin(
      router({
        "GET /health": (_req, res) =>
          sendHealth(res, [
            { method: "GET", path: `//127.0.0.1:${new URL(victim.url).port}/x` },
            { method: "GET", path: "/a" },
          ]),
        "GET /a": (_req, res) => send402(res, paymentRequired("https://svc.example/a")),
      }),
    );
    const catalog = catalogOf({ services: [svc.url] });
    await catalog.refresh();
    expect(victim.requests).toEqual([]);
    expect(catalog.list().items.map((i) => i.resource)).toEqual(["https://svc.example/a"]);
  });

  test("malformed 402 headers are skipped and the good ones listed", async () => {
    const valid = paymentRequired("https://svc.example/good");
    const bad: Record<string, (res: Parameters<Handler>[1]) => void> = {
      "/not-base64": (res) => send402Raw(res, "%%%"),
      "/not-json": (res) => send402Raw(res, Buffer.from("nope").toString("base64")),
      "/v1": (res) => send402(res, { ...valid, x402Version: 1 }),
      "/no-accepts": (res) => send402(res, { ...valid, accepts: [] }),
      "/no-url": (res) => send402(res, { ...valid, resource: {} }),
      "/ftp": (res) => send402(res, { ...valid, resource: { url: "ftp://svc.example/x" } }),
      "/bazaar": (res) => send402(res, { ...valid, extensions: { bazaar: bazaar("FETCH") } }),
      "/plain": (res) => sendJson(res, 200, {}),
      "/no-header": (res) => sendJson(res, 402, valid),
    };
    const lines: string[] = [];
    const specs: HealthRouteSpec[] = [{ method: "GET", path: "/good" }, ...Object.keys(bad).map((path) => ({ method: "GET", path }))];
    const svc = await origin((req, res) => {
      const path = pathOf(req);
      if (path === "/health") sendHealth(res, specs);
      else if (path === "/good") send402(res, valid);
      else bad[path]?.(res);
    });
    const catalog = catalogOf({ services: [svc.url], log: (line) => lines.push(line) });

    await catalog.refresh();
    await catalog.refresh();
    expect(catalog.list().items.map((i) => i.resource)).toEqual(["https://svc.example/good"]);
    expect(catalog.status()[0]).toMatchObject({ up: true, ready: true });
    const failures = lines.filter((line) => line.includes("failed its probe"));
    expect(failures).toHaveLength(Object.keys(bad).length);
  });
});

describe("refreshing", () => {
  test("callers that arrive during a refresh share it", async () => {
    let health = 0;
    const svc = await origin(
      router({
        "GET /health": (_req, res) => {
          health++;
          setTimeout(() => sendHealth(res, []), 100);
        },
      }),
    );
    const catalog = catalogOf({ services: [svc.url] });
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(health).toBe(1);
    await catalog.refresh();
    expect(health).toBe(2);
  });

  test("a loop never overlaps itself and keeps going", async () => {
    let active = 0;
    let most = 0;
    let health = 0;
    const svc = await origin(
      router({
        "GET /health": (_req, res) => {
          health++;
          active++;
          most = Math.max(most, active);
          setTimeout(() => {
            active--;
            sendHealth(res, []);
          }, 60);
        },
      }),
    );
    const catalog = catalogOf({ services: [svc.url] });
    await catalog.start(5);
    await vi.waitFor(() => expect(health).toBeGreaterThanOrEqual(4), { timeout: 3000, interval: 10 });
    await catalog.stop();
    const stopped = health;
    expect(most).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(health).toBe(stopped);
  });

  test("looks again sooner while a service is down, and lists it once it is up", async () => {
    const svc = mutable([{ method: "GET", path: "/a" }]);
    svc.state.down = true;
    const o = await origin(svc.handler);
    const catalog = catalogOf({ services: [o.url], retryMs: 20 });
    await catalog.start(60_000);
    expect(catalog.size).toBe(0);

    svc.state.down = false;
    await vi.waitFor(() => expect(catalog.size).toBe(1), { timeout: 3000, interval: 10 });
    await catalog.stop();
  });

  test("waits the whole interval once everything is up", async () => {
    let health = 0;
    const svc = await origin(
      router({
        "GET /health": (_req, res) => {
          health++;
          sendHealth(res, []);
        },
      }),
    );
    const catalog = catalogOf({ services: [svc.url], retryMs: 10 });
    await catalog.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await catalog.stop();
    expect(health).toBe(1);
  });

  test("stop cancels probes in flight at once and leaves the status alone", async () => {
    const hang = await hangingOrigin();
    const catalog = catalogOf({ services: [hang.url], timeoutMs: 10_000 });
    const refreshing = catalog.refresh();
    await vi.waitFor(() => expect(hang.requests).toHaveLength(1));

    const started = performance.now();
    await catalog.stop();
    await refreshing;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(catalog.status()[0]).toMatchObject({ up: false, checkedAt: null });

    await catalog.refresh();
    await catalog.start(10);
    expect(hang.requests).toHaveLength(1);
  });
});

describe("logging", () => {
  test("says once when a service goes down or comes back, and never repeats itself", async () => {
    const lines: string[] = [];
    const svc = mutable([{ method: "GET", path: "/a" }]);
    svc.state.down = true;
    const o = await origin(svc.handler);
    const catalog = catalogOf({ services: [o.url], log: (line) => lines.push(line) });

    await catalog.refresh();
    await catalog.refresh();
    expect(lines).toEqual([`${o.url} is down (/health answered HTTP 500)`]);

    svc.state.down = false;
    await catalog.refresh();
    await catalog.refresh();
    expect(lines).toEqual([`${o.url} is down (/health answered HTTP 500)`, `${o.url} is up with 1 route`]);

    svc.state.ready = false;
    await catalog.refresh();
    expect(lines.at(-1)).toBe(`${o.url} is not ready`);
  });

  test("a logger that throws does not stop anything", async () => {
    const svc = await stack();
    const catalog = catalogOf({
      services: [svc.url, await deadUrl()],
      log: () => {
        throw new Error("logger is broken");
      },
    });
    await catalog.refresh();
    expect(catalog.size).toBe(2);
  });
});
