import { describe, expect, test } from "vitest";
import { MAX_ITEMS, PAGE_LIMIT, pageQuery, readList } from "../src/lib/bazaar";

/** A Bazaar holding `total` items that serves pages of at most `size`, and the queries it was asked */
function bazaar(total: number, size = PAGE_LIMIT) {
  const asked: string[] = [];
  const read = async (query: string): Promise<unknown> => {
    asked.push(query);
    const offset = Number(new URLSearchParams(query).get("offset"));
    const items = Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => offset + i);
    return { x402Version: 2, items, pagination: { limit: size, offset, total } };
  };
  return { asked, read };
}

describe("pageQuery", () => {
  test("asks for the HTTP resources, 100 at a time, from the offset", () => {
    expect(pageQuery(0)).toBe("?type=http&limit=100&offset=0");
    expect(pageQuery(200)).toBe("?type=http&limit=100&offset=200");
  });
});

describe("readList", () => {
  test("reads one page when it holds the whole list", async () => {
    const { asked, read } = bazaar(5);
    expect(await readList(read)).toEqual({ items: [0, 1, 2, 3, 4], pages: 1 });
    expect(asked).toEqual([pageQuery(0)]);
  });

  test("follows the offset page by page until it reaches the total", async () => {
    const { asked, read } = bazaar(250);
    const list = await readList(read);
    expect(list?.items).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(list?.pages).toBe(3);
    expect(asked).toEqual([pageQuery(0), pageQuery(100), pageQuery(200)]);
  });

  test("moves by what each page held, for a Bazaar that serves smaller pages", async () => {
    const { asked, read } = bazaar(45, 20);
    expect((await readList(read))?.items).toEqual(Array.from({ length: 45 }, (_, i) => i));
    expect(asked).toEqual([pageQuery(0), pageQuery(20), pageQuery(40)]);
  });

  test("stops at an empty page, and after one page that gives no total", async () => {
    const short = await readList(async () => ({ items: [], pagination: { total: 10 } }));
    expect(short).toEqual({ items: [], pages: 1 });
    let calls = 0;
    const bare = await readList(async () => {
      calls++;
      return { items: ["a", "b"] };
    });
    expect(bare).toEqual({ items: ["a", "b"], pages: 1 });
    expect(calls).toBe(1);
  });

  test("fails the whole read at the first page that is not a list", async () => {
    const { read } = bazaar(250);
    let page = 0;
    expect(await readList(async (query) => (page++ === 0 ? read(query) : null))).toBeNull();
    expect(await readList(async () => ({ items: "nope" }))).toBeNull();
    expect(await readList(async () => [1, 2])).toBeNull();
  });

  test("never reads more than the facilitator can hold, whatever total a page claims", async () => {
    const { asked, read } = bazaar(1_000_000);
    const list = await readList(read);
    expect(list?.items).toHaveLength(MAX_ITEMS);
    expect(list?.pages).toBe(41);
    expect(asked).toHaveLength(41);
  });

  test("keeps what the facilitator can hold from one page that holds far more than a page", async () => {
    const { read } = bazaar(300_000, 300_000);
    const list = await readList(read);
    expect(list?.items).toHaveLength(MAX_ITEMS);
    expect(list?.items.at(-1)).toBe(MAX_ITEMS - 1);
    expect(list?.pages).toBe(1);
  });
});
