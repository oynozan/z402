import { afterEach, describe, expect, test } from "vitest";
import { ConvertPool } from "../src/convert-pool.js";
import { convertPage, type ConvertLimits, type PageInput } from "../src/convert.js";
import { PageError } from "../src/errors.js";

const LIMITS: ConvertLimits = { maxMarkdownBytes: 1024 * 1024, maxTags: 60_000 };
const pools: ConvertPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
});

function pool(o: { size?: number; timeoutMs?: number; memoryMb?: number } = {}): ConvertPool {
  const created = new ConvertPool({ size: o.size ?? 2, timeoutMs: o.timeoutMs ?? 20_000, memoryMb: o.memoryMb });
  pools.push(created);
  return created;
}

function page(html: string): PageInput {
  return { finalUrl: "https://example.com/", contentType: "text/html", charset: undefined, body: Buffer.from(html) };
}

const PARAGRAPH = "<p>Lorem ipsum <a href='/x'>dolor</a> sit amet, consectetur adipiscing elit.</p>";
const PARAGRAPHS = (n: number): string => `<html><body><article>${PARAGRAPH.repeat(n)}</article></body></html>`;

async function refusal(work: Promise<unknown>): Promise<PageError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof PageError) return e;
    throw e;
  }
  throw new Error("expected a PageError");
}

describe("ConvertPool", { timeout: 60_000 }, () => {
  test("converts on a worker thread, with the same result as the main thread", async () => {
    const converter = pool();
    await converter.warm();
    expect(converter.workers).toBe(1);
    expect(converter.onMainThread).toBe(false);
    const input = page(
      "<html><head><title>T</title></head><body><article><h2>Head</h2><p>Body text.</p></article></body></html>",
    );
    expect(await converter.convert(input, LIMITS)).toEqual(convertPage(input, LIMITS));
    expect(converter.workers).toBe(1);
  });

  test("runs pages side by side up to its size", async () => {
    const converter = pool({ size: 2 });
    const results = await Promise.all([1, 2, 3, 4].map((n) => converter.convert(page(PARAGRAPHS(n)), LIMITS)));
    expect(results.map((r) => r.markdown.split("\n\n").length)).toEqual([1, 2, 3, 4]);
    expect(converter.workers).toBeLessThanOrEqual(2);
  });

  test("a page over the tag budget is refused as too large", async () => {
    const e = await refusal(pool().convert(page(`<body>${"<i>".repeat(LIMITS.maxTags + 1)}</body>`), LIMITS));
    expect(e.code).toBe("too_large");
  });

  test("a conversion past its deadline ends its worker, and the next page gets a new one", async () => {
    // A heap large enough that only the deadline can stop this page
    const converter = pool({ size: 1, timeoutMs: 500, memoryMb: 1024 });
    await converter.warm();
    // About 50,000 tags, under the budget, which takes seconds to convert
    const e = await refusal(converter.convert(page(PARAGRAPHS(25_000)), LIMITS));
    expect(e.code).toBe("too_large");
    expect(e.message).toMatch(/took more than 500 ms/);
    expect(converter.workers).toBe(0);
    expect((await converter.convert(page(PARAGRAPHS(1)), LIMITS)).markdown).toContain("Lorem ipsum");
    expect(converter.workers).toBe(1);
  });

  test("a worker that runs out of memory takes only that page down", async () => {
    const converter = pool({ size: 1, memoryMb: 48 });
    await converter.warm();
    expect(converter.onMainThread).toBe(false);
    const e = await refusal(converter.convert(page(PARAGRAPHS(20_000)), LIMITS));
    expect(e.code).toBe("too_large");
    expect(e.message).toMatch(/memory/);
    expect((await converter.convert(page(PARAGRAPHS(2)), LIMITS)).markdown).toContain("dolor");
  });

  test("close ends every worker and refuses new pages", async () => {
    const converter = pool();
    await converter.warm();
    await converter.close();
    expect(converter.workers).toBe(0);
    expect((await refusal(converter.convert(page(PARAGRAPHS(1)), LIMITS))).code).toBe("convert_failed");
  });
});
