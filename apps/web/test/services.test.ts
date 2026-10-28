import { describe, expect, test } from "vitest";
import {
  buildBoard,
  groupOffers,
  healthOf,
  mergeStatus,
  OTHER,
  parseResources,
  parseStatus,
} from "../src/lib/services";
import { AGE_FILE, DROPS, HOLD, ITEMS, LLM, MARKDOWN, PAY_TO, item, status } from "./fixtures";

describe("parseResources", () => {
  test("reads the response object and keeps what the site shows", () => {
    const offers = parseResources({ x402Version: 2, items: ITEMS, pagination: { limit: 1000, offset: 0, total: 5 } });
    expect(offers).toHaveLength(5);
    expect(offers?.[0]).toEqual({
      url: "http://localhost:4031/v1/generate",
      serviceName: "LLM inference",
      method: "POST",
      description: "Streams qwen2.5-0.5b-instruct output, one chunk of about 32 tokens per paid call.",
      unit: "output chunk",
      note: "The operator sees your prompts. Open-weights model.",
      priceZat: "500",
      tags: ["llm", "inference", "text"],
      input: { queryParams: null, pathParams: null, bodyType: "json", body: { prompt: "Write a haiku about privacy." } },
      output: JSON.stringify({ stream: "<id>", index: 0, text: "...", done: false }, null, 2),
      terms: {
        scheme: "prepaid-voucher",
        network: "zcash:regtest",
        asset: "ZEC",
        payTo: PAY_TO,
        windowZat: "100000",
        creditRatioBps: 2500,
        creditCapZat: "200000",
      },
    });
  });

  test("reads query parameters, path parameters and a text body", () => {
    const [markdown, drops, hold] = parseResources({ items: [MARKDOWN, DROPS, HOLD] })!;
    expect(markdown?.method).toBe("GET");
    expect(markdown?.input).toEqual({ queryParams: { url: "https://example.com" }, pathParams: null, bodyType: null, body: null });
    expect(drops?.input?.body).toBe(AGE_FILE);
    expect(hold?.input).toEqual({ queryParams: null, pathParams: { id: "example" }, bodyType: "json", body: {} });
  });

  test("skips items without a resource and tolerates missing extensions", () => {
    const offers = parseResources({ items: [{ type: "http" }, { resource: "http://x.test/a", accepts: "nope" }, 7] });
    expect(offers).toEqual([
      {
        url: "http://x.test/a",
        serviceName: null,
        method: "GET",
        description: null,
        unit: null,
        note: null,
        priceZat: null,
        tags: [],
        input: null,
        output: null,
        terms: null,
      },
    ]);
  });

  test("falls back to POST for a body route that declared no method", () => {
    const raw = item("http://x.test/a", { serviceName: "A", input: { bodyType: "json", body: {} } });
    expect(parseResources({ items: [raw] })?.[0]?.method).toBe("POST");
  });

  test("keeps tags lower case, once each, and refuses terms it cannot read", () => {
    const raw = item("http://x.test/a", { tags: ["LLM", " llm ", "", 7 as unknown as string, "Text"] });
    raw.accepts[0]!.extra = { windowZat: "1e5", creditRatioBps: 10_001, creditCapZat: 5 };
    const [offer] = parseResources({ items: [raw] })!;
    expect(offer?.tags).toEqual(["llm", "text"]);
    expect(offer?.terms).toMatchObject({ windowZat: null, creditRatioBps: null, creditCapZat: "5" });
  });

  test("cuts a very long example answer", () => {
    const raw = item("http://x.test/a", { output: { text: "x".repeat(10_000) } });
    const output = parseResources({ items: [raw] })?.[0]?.output ?? "";
    expect(output.length).toBeLessThan(4_100);
    expect(output.endsWith("…")).toBe(true);
  });

  test("returns null for a body that is not a resource list", () => {
    expect(parseResources(null)).toBeNull();
    expect(parseResources({ error: "x" })).toBeNull();
    expect(parseResources("text")).toBeNull();
  });
});

describe("parseStatus", () => {
  test("reads the array the discovery service sends, and the older object form", () => {
    const entry = status({ callsToday: "7", priceZat: 500, latencyMs: 2.6 });
    const expected = {
      serviceName: "LLM inference",
      url: "http://localhost:4031",
      up: true,
      ready: true,
      latencyMs: 3,
      callsToday: 7,
      unit: "output chunk",
      priceZat: "500",
    };
    expect(parseStatus([entry])).toEqual([expected]);
    expect(parseStatus({ services: [entry, { url: "http://x.test" }, null] })).toEqual([
      expected,
      {
        serviceName: null,
        url: "http://x.test",
        up: false,
        ready: null,
        latencyMs: null,
        callsToday: null,
        unit: null,
        priceZat: null,
      },
    ]);
  });

  test("returns null when there is no service list", () => {
    expect(parseStatus({})).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
  });
});

describe("groupOffers", () => {
  const rows = () => groupOffers(parseResources({ items: ITEMS }) ?? []);

  test("makes one row per service name, in discovery order, each with its category", () => {
    expect(rows().map((r) => [r.name, r.category])).toEqual([
      ["LLM inference", "llm"],
      ["URL to markdown", "web"],
      ["Text embeddings", "embeddings"],
      ["Encrypted drop box", "storage"],
    ]);
  });

  test("keeps every paid route of a service, with its method, path, example and note", () => {
    const drop = rows()[3];
    expect(drop?.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/drops", "POST /v1/drops/:id/hold"]);
    expect(drop?.routes.map((r) => r.note)).toEqual([
      "Only client-side encrypted (age) blobs. Size and time are capped.",
      null,
    ]);
    expect(drop?.routes[1]?.input?.pathParams).toEqual({ id: "example" });
    expect(drop?.notes).toEqual(["Only client-side encrypted (age) blobs. Size and time are capped."]);
    expect(drop?.tags).toEqual(["storage", "handoff", "encrypted"]);
  });

  test("lists a route discovery repeats once", () => {
    expect(groupOffers(parseResources({ items: [LLM, LLM] }) ?? [])[0]?.routes).toHaveLength(1);
  });

  test("groups unnamed routes by origin, names them by host and files them under other", () => {
    const grouped = groupOffers(parseResources({ items: [item("http://a.test:81/x"), item("http://a.test:81/y")] }) ?? []);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.name).toBe("a.test:81");
    expect(grouped[0]?.category).toBe(OTHER);
    expect(grouped[0]?.routes.map((r) => r.path)).toEqual(["/x", "/y"]);
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

  test("mergeStatus matches by name, else by origin, and keeps the count and latency", () => {
    const merged = mergeStatus(
      groupOffers(parseResources({ items: ITEMS }) ?? []),
      parseStatus([
        status({ callsToday: 12, latencyMs: 4 }),
        status({ serviceName: "markdown", url: "http://localhost:4032", ready: false, callsToday: 0, latencyMs: 9 }),
      ]),
    );
    expect(merged.map((r) => [r.name, r.health, r.callsToday, r.latencyMs])).toEqual([
      ["LLM inference", "up", 12, 4],
      ["URL to markdown", "starting", 0, 9],
      ["Text embeddings", "unknown", null, null],
      ["Encrypted drop box", "unknown", null, null],
    ]);
  });

  test("mergeStatus adds a service that only status knows", () => {
    const merged = mergeStatus(
      [],
      parseStatus([status({ serviceName: "Text embeddings", url: "http://localhost:4033", up: false, latencyMs: null })]),
    );
    expect(merged).toEqual([
      {
        key: "name:Text embeddings",
        name: "Text embeddings",
        category: OTHER,
        tags: [],
        routes: [],
        notes: [],
        health: "down",
        latencyMs: null,
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

  test("is ready with a row per service", () => {
    const board = buildBoard({ offers: parseResources({ items: ITEMS }), status: parseStatus([status({})]) });
    expect(board.state).toBe("ready");
    expect(board.services).toHaveLength(4);
  });
});
