import { describe, expect, test } from "vitest";
import type { DiscoveryResource, DiscoveryStatusEntry } from "../src/lib/discovery-types";
import {
  buildBoard,
  groupOffers,
  healthOf,
  mergeStatus,
  parseResources,
  parseStatus,
  summarize,
} from "../src/lib/services";

const PAY_TO = `uregtest1${"q".repeat(60)}`;

function item(
  resource: string,
  serviceName: string | undefined,
  method: string | undefined,
  z402: { unit?: string; note?: string } = {},
  amount = "500",
): DiscoveryResource {
  return {
    resource,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "prepaid-voucher",
        network: "zcash:regtest",
        amount,
        asset: "ZEC",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
      },
    ],
    lastUpdated: "2026-10-27T12:00:00.000Z",
    description: `Calls ${resource}`,
    mimeType: "application/json",
    ...(serviceName !== undefined && { serviceName }),
    extensions: {
      bazaar: { info: { input: { type: "http", ...(method !== undefined && { method }) } }, schema: {} },
      z402,
    },
  };
}

const ITEMS = [
  item("http://localhost:4031/v1/generate", "LLM inference", "POST", { unit: "output chunk", note: "The operator sees prompts." }),
  item("http://localhost:4032/v1/markdown", "URL to markdown", "GET", { unit: "page" }),
  item("http://localhost:4034/v1/drops", "Encrypted drop box", "POST", { unit: "10 blocks", note: "Encrypted blobs only." }),
  item("http://localhost:4034/v1/drops/:id/hold", "Encrypted drop box", "POST", { unit: "10 blocks", note: "Encrypted blobs only." }),
];

const status = (over: DiscoveryStatusEntry): DiscoveryStatusEntry => ({
  serviceName: "LLM inference",
  url: "http://localhost:4031",
  up: true,
  ready: true,
  latencyMs: 3,
  checkedAt: "2026-10-27T12:00:00.000Z",
  callsToday: 12,
  unit: "output chunk",
  priceZat: "500",
  ...over,
});

describe("parseResources", () => {
  test("reads the response object and keeps what the site shows", () => {
    const offers = parseResources({ x402Version: 2, items: ITEMS, pagination: { limit: 1000, offset: 0, total: 4 } });
    expect(offers).toHaveLength(4);
    expect(offers?.[0]).toEqual({
      url: "http://localhost:4031/v1/generate",
      serviceName: "LLM inference",
      method: "POST",
      description: "Calls http://localhost:4031/v1/generate",
      unit: "output chunk",
      note: "The operator sees prompts.",
      priceZat: "500",
    });
  });

  test("skips items without a resource and tolerates missing extensions", () => {
    const offers = parseResources({ items: [{ type: "http" }, { resource: "http://x.test/a", accepts: "nope" }, 7] });
    expect(offers).toEqual([
      { url: "http://x.test/a", serviceName: null, method: "GET", description: null, unit: null, note: null, priceZat: null },
    ]);
  });

  test("falls back to POST for a body route that declared no method", () => {
    const raw = item("http://x.test/a", "A", undefined);
    raw.extensions = { bazaar: { info: { input: { type: "http", bodyType: "json", body: {} } } } };
    expect(parseResources({ items: [raw] })?.[0]?.method).toBe("POST");
  });

  test("returns null for a body that is not a resource list", () => {
    expect(parseResources(null)).toBeNull();
    expect(parseResources({ error: "x" })).toBeNull();
    expect(parseResources("text")).toBeNull();
  });
});

describe("parseStatus", () => {
  test("reads each entry and coerces the loose fields", () => {
    const parsed = parseStatus({ services: [status({ callsToday: "7", priceZat: 500 }), { url: "http://x.test" }, null] });
    expect(parsed).toEqual([
      {
        serviceName: "LLM inference",
        url: "http://localhost:4031",
        up: true,
        ready: true,
        callsToday: 7,
        unit: "output chunk",
        priceZat: "500",
      },
      { serviceName: null, url: "http://x.test", up: false, ready: null, callsToday: null, unit: null, priceZat: null },
    ]);
  });

  test("returns null when there is no service list", () => {
    expect(parseStatus({})).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
  });
});

describe("groupOffers", () => {
  test("makes one row per service name, in discovery order", () => {
    const rows = groupOffers(parseResources({ items: ITEMS }) ?? []);
    expect(rows.map((r) => r.name)).toEqual(["LLM inference", "URL to markdown", "Encrypted drop box"]);
  });

  test("keeps every paid route of a service, with its method and path", () => {
    const drop = groupOffers(parseResources({ items: ITEMS }) ?? [])[2];
    expect(drop?.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/drops", "POST /v1/drops/:id/hold"]);
    expect(drop?.routes.map((r) => r.unit)).toEqual(["10 blocks", "10 blocks"]);
    expect(drop?.notes).toEqual(["Encrypted blobs only."]);
  });

  test("lists a route discovery repeats once", () => {
    const rows = groupOffers(parseResources({ items: [ITEMS[0], ITEMS[0]] }) ?? []);
    expect(rows[0]?.routes).toHaveLength(1);
  });

  test("groups unnamed routes by origin and names them by host", () => {
    const rows = groupOffers(
      parseResources({ items: [item("http://a.test:81/x", undefined, "GET"), item("http://a.test:81/y", undefined, "GET")] }) ?? [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("a.test:81");
    expect(rows[0]?.routes.map((r) => r.path)).toEqual(["/x", "/y"]);
  });
});

describe("status", () => {
  test("healthOf reads up and ready", () => {
    const [up, starting, down, unsure] = parseStatus({
      services: [status({}), status({ ready: false }), status({ up: false }), status({ ready: undefined })],
    })!;
    expect(healthOf(up)).toBe("up");
    expect(healthOf(starting)).toBe("starting");
    expect(healthOf(down)).toBe("down");
    expect(healthOf(unsure)).toBe("up");
    expect(healthOf(undefined)).toBe("unknown");
  });

  test("mergeStatus matches by name, else by origin, and keeps the count", () => {
    const rows = groupOffers(parseResources({ items: ITEMS }) ?? []);
    const merged = mergeStatus(
      rows,
      parseStatus({
        services: [
          status({ callsToday: 12 }),
          status({ serviceName: "markdown", url: "http://localhost:4032", ready: false, callsToday: 0 }),
        ],
      }),
    );
    expect(merged.map((r) => [r.name, r.health, r.callsToday])).toEqual([
      ["LLM inference", "up", 12],
      ["URL to markdown", "starting", 0],
      ["Encrypted drop box", "unknown", null],
    ]);
  });

  test("mergeStatus adds a service that only status knows", () => {
    const merged = mergeStatus(
      [],
      parseStatus({ services: [status({ serviceName: "Text embeddings", url: "http://localhost:4033", up: false })] }),
    );
    expect(merged).toEqual([
      {
        key: "name:Text embeddings",
        name: "Text embeddings",
        routes: [],
        notes: [],
        health: "down",
        callsToday: 12,
        unit: "output chunk",
        priceZat: "500",
      },
    ]);
  });
});

describe("buildBoard", () => {
  test("is unreachable only when both reads failed", () => {
    expect(buildBoard({ offers: null, status: null })).toEqual({ state: "unreachable", services: [] });
    expect(buildBoard({ offers: [], status: null }).state).toBe("empty");
    expect(buildBoard({ offers: null, status: [] }).state).toBe("empty");
  });

  test("counts the services and those up", () => {
    const board = buildBoard({
      offers: parseResources({ items: ITEMS }),
      status: parseStatus({
        services: [
          status({}),
          status({ serviceName: "URL to markdown", url: "http://localhost:4032" }),
          status({ serviceName: "Encrypted drop box", url: "http://localhost:4034", ready: false }),
        ],
      }),
    });
    expect(board.state).toBe("ready");
    expect(summarize(board)).toEqual({ services: 3, up: 2 });
  });
});
