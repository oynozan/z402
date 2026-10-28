import { describe, expect, test } from "vitest";
import { buildBoard, groupOffers, healthOf, OTHER, parseResources } from "../src/lib/services";
import { AGE_FILE, DROPS, HOLD, ITEMS, LLM, MARKDOWN, NOW, PAY_TO, PROVIDER_2, ago, item } from "./fixtures";

describe("parseResources", () => {
  test("reads the response object and keeps what the site shows", () => {
    const offers = parseResources({ x402Version: 2, items: ITEMS, pagination: { limit: 100, offset: 0, total: 5 } });
    expect(offers).toHaveLength(5);
    expect(offers?.[0]).toEqual({
      url: "http://localhost:4031/v1/generate",
      serviceName: "LLM inference",
      method: "POST",
      description: "Streams qwen2.5-0.5b-instruct output, one chunk of about 32 tokens per paid call.",
      unit: "output chunk",
      note: "The operator sees your prompts. Open-weights model.",
      priceZat: "200",
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
      lastSeen: NOW - 12_000,
      paidCallsToday: 128,
    });
  });

  test("reads each route's own price and payee", () => {
    const offers = parseResources({ items: ITEMS }) ?? [];
    expect(offers.map((o) => [o.priceZat, o.terms?.payTo])).toEqual([
      ["200", PAY_TO],
      ["1000", PROVIDER_2],
      ["100", PAY_TO],
      ["500", PAY_TO],
      ["500", PAY_TO],
    ]);
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
        lastSeen: null,
        paidCallsToday: null,
      },
    ]);
  });

  test("reads lastSeen in ISO 8601 only, and paidCallsToday as a whole count", () => {
    const read = (lastSeen: unknown, paidCallsToday: unknown) =>
      parseResources({ items: [{ resource: "http://x.test/a", lastSeen, paidCallsToday }] })?.[0];
    expect(read("2026-10-28T11:59:48.000Z", 7)).toMatchObject({ lastSeen: NOW - 12_000, paidCallsToday: 7 });
    expect(read("2026-10-28T13:59:48+02:00", "7")).toMatchObject({ lastSeen: NOW - 12_000, paidCallsToday: 7 });
    for (const bad of [String(NOW), NOW, "Wed, 28 Oct 2026 12:00:00 GMT", "2026-13-45T99:99Z", "", null]) {
      expect(read(bad, undefined), String(bad)).toMatchObject({ lastSeen: null, paidCallsToday: null });
    }
    for (const bad of [-1, 1.5, "1e3", Number.MAX_SAFE_INTEGER + 1, {}]) {
      expect(read(undefined, bad)?.paidCallsToday, String(bad)).toBeNull();
    }
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

describe("groupOffers", () => {
  const rows = () => groupOffers(parseResources({ items: ITEMS }) ?? [], NOW);

  test("makes one row per service, in the Bazaar's order, each with its category", () => {
    expect(rows().map((r) => [r.name, r.category])).toEqual([
      ["LLM inference", "llm"],
      ["URL to markdown", "web"],
      ["Text embeddings", "embeddings"],
      ["Encrypted drop box", "storage"],
    ]);
  });

  test("keeps every paid route of a service, with its method, path, price, example and note", () => {
    const drop = rows()[3];
    expect(drop?.routes.map((r) => `${r.method} ${r.path} ${r.priceZat}`)).toEqual([
      "POST /v1/drops 500",
      "POST /v1/drops/:id/hold 500",
    ]);
    expect(drop?.routes.map((r) => r.note)).toEqual([
      "Only client-side encrypted (age) blobs. Size and time are capped.",
      null,
    ]);
    expect(drop?.routes[1]?.input?.pathParams).toEqual({ id: "example" });
    expect(drop?.notes).toEqual(["Only client-side encrypted (age) blobs. Size and time are capped."]);
    expect(drop?.tags).toEqual(["storage", "handoff", "encrypted"]);
  });

  test("lists a route the Bazaar repeats once, and counts its calls once", () => {
    const [row] = groupOffers(parseResources({ items: [LLM, LLM] }) ?? [], NOW);
    expect(row?.routes).toHaveLength(1);
    expect(row?.callsToday).toBe(128);
  });

  test("groups unnamed routes by origin, names them by host and files them under other", () => {
    const grouped = groupOffers(parseResources({ items: [item("http://a.test:81/x"), item("http://a.test:81/y")] }) ?? [], NOW);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.name).toBe("a.test:81");
    expect(grouped[0]?.category).toBe(OTHER);
    expect(grouped[0]?.routes.map((r) => r.path)).toEqual(["/x", "/y"]);
  });

  test("never joins two providers' routes by their name", () => {
    const named = (url: string, payTo: string, serviceName = "LLM inference") =>
      item(url, { serviceName, payTo, z402: { unit: "output chunk" }, amount: "1" });
    const grouped = groupOffers(
      parseResources({
        items: [
          LLM,
          named("http://elsewhere.test/v1/generate", PAY_TO),
          named("http://localhost:4031/v1/cheap", PROVIDER_2),
          named("http://localhost:4031/v1/other", PAY_TO, "Something else"),
          named("http://localhost:4031/v1/more", PAY_TO),
        ],
      }) ?? [],
      NOW,
    );
    expect(grouped.map((r) => [r.name, r.routes.map((route) => route.path)])).toEqual([
      ["LLM inference", ["/v1/generate", "/v1/more"]],
      ["LLM inference", ["/v1/generate"]],
      ["LLM inference", ["/v1/cheap"]],
      ["Something else", ["/v1/other"]],
    ]);
    expect(new Set(grouped.map((r) => r.key)).size).toBe(4);
  });
});

describe("status", () => {
  test("healthOf reads the age of a declaration: up under 90 s, stale under 10 min, down after", () => {
    expect(healthOf(NOW, NOW)).toBe("up");
    expect(healthOf(NOW - 89_999, NOW)).toBe("up");
    expect(healthOf(NOW - 90_000, NOW)).toBe("stale");
    expect(healthOf(NOW - 599_999, NOW)).toBe("stale");
    expect(healthOf(NOW - 600_000, NOW)).toBe("down");
    expect(healthOf(NOW - 86_400_000, NOW)).toBe("down");
  });

  test("healthOf never reads up without a declaration, a fresh read, or a time that makes sense", () => {
    expect(healthOf(null, NOW)).toBe("none");
    expect(healthOf(NOW, null)).toBe("unknown");
    expect(healthOf(null, null)).toBe("unknown");
    expect(healthOf(NOW + 30_000, NOW)).toBe("up");
    expect(healthOf(NOW + 120_000, NOW)).toBe("unknown");
  });

  test("each service is as fresh as its latest declaration, and counts the paid calls of all its routes", () => {
    expect(rowsAt(NOW).map((r) => [r.name, r.health, r.callsToday])).toEqual([
      ["LLM inference", "up", 128],
      ["URL to markdown", "none", 41],
      ["Text embeddings", "stale", 0],
      ["Encrypted drop box", "down", 9],
    ]);
    const mixed = groupOffers(
      parseResources({
        items: [
          item("http://a.test/x", { serviceName: "A", lastSeen: ago(1_200_000) }),
          item("http://a.test/y", { serviceName: "A", lastSeen: ago(10_000) }),
          item("http://a.test/z", { serviceName: "A" }),
        ],
      }) ?? [],
      NOW,
    );
    expect(mixed.map((r) => [r.health, r.lastSeen, r.callsToday])).toEqual([["up", NOW - 10_000, null]]);
  });

  test("a list that is no longer read fresh keeps its rows without a status or a count", () => {
    expect(rowsAt(null).map((r) => [r.health, r.callsToday])).toEqual([
      ["unknown", null],
      ["unknown", null],
      ["unknown", null],
      ["unknown", null],
    ]);
  });
});

function rowsAt(at: number | null) {
  return groupOffers(parseResources({ items: ITEMS }) ?? [], at);
}

describe("buildBoard", () => {
  test("is unreachable only when the list could not be read", () => {
    expect(buildBoard({ offers: null, at: null })).toEqual({ state: "unreachable", services: [] });
    expect(buildBoard({ offers: [], at: NOW })).toEqual({ state: "empty", services: [] });
  });

  test("is ready with a row per service", () => {
    const board = buildBoard({ offers: parseResources({ items: ITEMS }), at: NOW });
    expect(board.state).toBe("ready");
    expect(board.services).toHaveLength(4);
  });
});
