import { describe, expect, test } from "vitest";
import {
  categories,
  filterServices,
  matchesQuery,
  priceText,
  slugOf,
  totals,
  unitText,
} from "../src/lib/catalog";
import { DASH } from "../src/lib/format";
import { buildBoard, OTHER, parseResources, parseStatus, type ServiceRow } from "../src/lib/services";
import { ITEMS, item, status } from "./fixtures";

function services(): ServiceRow[] {
  return buildBoard({
    offers: parseResources({ items: ITEMS }),
    status: parseStatus([
      status({ callsToday: 128 }),
      status({ serviceName: "URL to markdown", url: "http://localhost:4032", callsToday: 41, unit: "page" }),
      status({ serviceName: "Text embeddings", url: "http://localhost:4033", ready: false, callsToday: 0, unit: "1k tokens" }),
      status({ serviceName: "Encrypted drop box", url: "http://localhost:4034", callsToday: 9, unit: "10 blocks" }),
    ]),
  }).services;
}

const names = (rows: ServiceRow[]) => rows.map((r) => r.name);

describe("categories", () => {
  test("one cell per first tag, in discovery order while the counts tie", () => {
    expect(categories(services())).toEqual([
      { key: "llm", count: 1 },
      { key: "web", count: 1 },
      { key: "embeddings", count: 1 },
      { key: "storage", count: 1 },
    ]);
  });

  test("the largest category first and other last", () => {
    const rows = buildBoard({
      offers: parseResources({
        items: [
          item("http://u.test/a"),
          item("http://a.test/x", { serviceName: "A", tags: ["web"] }),
          item("http://b.test/x", { serviceName: "B", tags: ["llm"] }),
          item("http://c.test/x", { serviceName: "C", tags: ["llm"] }),
        ],
      }),
      status: null,
    }).services;
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
    const [onlyStatus] = buildBoard({ offers: [], status: parseStatus([status({ serviceName: "Odd One" })]) }).services;
    expect(slugOf(onlyStatus!)).toBe("odd-one");
    const [unnamed] = buildBoard({ offers: parseResources({ items: [item("http://a.test/v1/:id", { tags: ["web"] })] }), status: null })
      .services;
    expect(slugOf(unnamed!)).toBe("web");
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
    expect(totals(services())).toEqual({ services: 4, up: 3, callsToday: 178 });
  });

  test("knows neither the services up nor the calls until status reports them", () => {
    expect(totals(buildBoard({ offers: parseResources({ items: ITEMS }), status: null }).services)).toEqual({
      services: 4,
      up: null,
      callsToday: null,
    });
  });

  test("counts none up when status reports every service down", () => {
    const rows = buildBoard({
      offers: parseResources({ items: ITEMS }),
      status: parseStatus([status({ up: false, callsToday: null })]),
    }).services;
    expect(totals(rows)).toEqual({ services: 4, up: 0, callsToday: null });
  });
});

describe("row text", () => {
  test("one price and one unit for a service whose routes agree", () => {
    const drop = services()[3]!;
    expect(priceText(drop)).toBe("500 zat");
    expect(unitText(drop)).toBe("10 blocks");
  });

  test("a price range and each unit when the routes differ", () => {
    const [row] = buildBoard({
      offers: parseResources({
        items: [
          item("http://a.test/x", { serviceName: "A", amount: "500", z402: { unit: "page" } }),
          item("http://a.test/y", { serviceName: "A", amount: "2000", z402: { unit: "site" } }),
        ],
      }),
      status: null,
    }).services;
    expect(priceText(row!)).toBe("500–2,000 zat");
    expect(unitText(row!)).toBe("page, site");
  });

  test("falls back to what status says for a service with no routes", () => {
    const [row] = buildBoard({ offers: [], status: parseStatus([status({ unit: null, priceZat: null })]) }).services;
    expect(priceText(row!)).toBe(DASH);
    expect(unitText(row!)).toBe(DASH);
  });
});
