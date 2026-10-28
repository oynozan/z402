import { describe, expect, test } from "vitest";
import {
  categories,
  filterServices,
  matchesQuery,
  pricedPerRoute,
  priceText,
  slugOf,
  totals,
  unitText,
} from "../src/lib/catalog";
import { DASH } from "../src/lib/format";
import { buildBoard, OTHER, parseResources, type ServiceRow } from "../src/lib/services";
import { ITEMS, NOW, ago, item } from "./fixtures";

function services(at: number | null = NOW): ServiceRow[] {
  return buildBoard({ offers: parseResources({ items: ITEMS }), at }).services;
}

function rowsOf(items: ReturnType<typeof item>[]): ServiceRow[] {
  return buildBoard({ offers: parseResources({ items }), at: NOW }).services;
}

const names = (rows: ServiceRow[]) => rows.map((r) => r.name);

describe("categories", () => {
  test("one cell per first tag, in the Bazaar's order while the counts tie", () => {
    expect(categories(services())).toEqual([
      { key: "llm", count: 1 },
      { key: "web", count: 1 },
      { key: "embeddings", count: 1 },
      { key: "storage", count: 1 },
    ]);
  });

  test("the largest category first and other last", () => {
    const rows = rowsOf([
      item("http://u.test/a"),
      item("http://a.test/x", { serviceName: "A", tags: ["web"] }),
      item("http://b.test/x", { serviceName: "B", tags: ["llm"] }),
      item("http://c.test/x", { serviceName: "C", tags: ["llm"] }),
    ]);
    expect(categories(rows).map((c) => `${c.key} ${c.count}`)).toEqual(["llm 2", "web 1", `${OTHER} 1`]);
  });

  test("none for no services", () => {
    expect(categories([])).toEqual([]);
  });
});

describe("slugOf", () => {
  test("names the category and the first route", () => {
    expect(services().map(slugOf)).toEqual(["llm/generate", "web/markdown", "embeddings", "storage/drops"]);
  });

  test("falls back to the category, or to the name for a service without either", () => {
    const [named] = rowsOf([item("http://a.test/v1/:id", { serviceName: "Odd One" })]);
    expect(slugOf(named!)).toBe("odd-one");
    const [tagged] = rowsOf([item("http://a.test/v1/:id", { tags: ["web"] })]);
    expect(slugOf(tagged!)).toBe("web");
  });
});

describe("search", () => {
  test("matches the name, category, tags, unit, path and description, ignoring case", () => {
    const rows = services();
    const find = (query: string) => names(rows.filter((s) => matchesQuery(s, query)));
    expect(find("LLM")).toEqual(["LLM inference"]);
    expect(find("vectors")).toEqual(["Text embeddings"]);
    expect(find("rag")).toEqual(["Text embeddings", "Encrypted drop box"]);
    expect(find("10 blocks")).toEqual(["Encrypted drop box"]);
    expect(find("/v1/drops/:id")).toEqual(["Encrypted drop box"]);
    expect(find("markdown")).toEqual(["URL to markdown"]);
    expect(find("openai-style")).toEqual(["Text embeddings"]);
  });

  test("needs every word somewhere, and an empty query matches everything", () => {
    const rows = services();
    expect(names(rows.filter((s) => matchesQuery(s, "chunk llm")))).toEqual(["LLM inference"]);
    expect(names(rows.filter((s) => matchesQuery(s, "chunk storage")))).toEqual([]);
    expect(rows.filter((s) => matchesQuery(s, "   "))).toHaveLength(4);
  });

  test("filterServices combines the category and the query", () => {
    const rows = services();
    expect(names(filterServices(rows, { category: null, query: "" }))).toHaveLength(4);
    expect(names(filterServices(rows, { category: "storage", query: "" }))).toEqual(["Encrypted drop box"]);
    expect(names(filterServices(rows, { category: "storage", query: "haiku" }))).toEqual([]);
    expect(names(filterServices(rows, { category: null, query: "page" }))).toEqual(["URL to markdown"]);
  });
});

describe("totals", () => {
  test("counts the services, those up and the paid calls today", () => {
    expect(totals(services())).toEqual({ services: 4, up: 1, callsToday: 178 });
  });

  test("knows neither the services up nor the calls while the list is not read fresh", () => {
    expect(totals(services(null))).toEqual({ services: 4, up: null, callsToday: null });
  });

  test("knows no services up while none has declared itself, and still counts the calls", () => {
    const rows = rowsOf([item("http://a.test/x", { serviceName: "A", paidCallsToday: 5 })]);
    expect(totals(rows)).toEqual({ services: 1, up: null, callsToday: 5 });
  });

  test("counts none up when every service is stale or down, and no calls until one is counted", () => {
    const rows = rowsOf([
      item("http://a.test/x", { serviceName: "A", lastSeen: ago(120_000) }),
      item("http://b.test/x", { serviceName: "B", lastSeen: ago(3_600_000) }),
    ]);
    expect(totals(rows)).toEqual({ services: 2, up: 0, callsToday: null });
  });
});

describe("row text", () => {
  test("each service shows the price of its own routes", () => {
    expect(services().map((s) => [priceText(s), unitText(s)])).toEqual([
      ["200 zat", "output chunk"],
      ["1,000 zat", "page"],
      ["100 zat", "1k tokens"],
      ["500 zat", "10 blocks"],
    ]);
  });

  test("a price range and each unit when the routes differ", () => {
    const [row] = rowsOf([
      item("http://a.test/x", { serviceName: "A", amount: "500", z402: { unit: "page" } }),
      item("http://a.test/y", { serviceName: "A", amount: "2000", z402: { unit: "site" } }),
    ]);
    expect(priceText(row!)).toBe("500–2,000 zat");
    expect(unitText(row!)).toBe("page, site");
  });

  test("each route names its own price only when the routes of a service charge differently", () => {
    expect(services().map(pricedPerRoute)).toEqual([false, false, false, false]);
    const [mixed, same] = rowsOf([
      item("http://a.test/x", { serviceName: "A", amount: "500" }),
      item("http://a.test/y", { serviceName: "A", amount: "2000" }),
      item("http://b.test/x", { serviceName: "B", amount: "0500" }),
      item("http://b.test/y", { serviceName: "B", amount: "500" }),
    ]);
    expect(pricedPerRoute(mixed!)).toBe(true);
    expect(pricedPerRoute(same!)).toBe(false);
  });

  test("a dash for a route without a readable price or unit", () => {
    const [row] = rowsOf([item("http://a.test/x", { serviceName: "A", amount: "free" })]);
    expect(priceText(row!)).toBe(DASH);
    expect(unitText(row!)).toBe(DASH);
  });
});
