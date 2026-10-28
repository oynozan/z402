import { describe, expect, test } from "vitest";
import { buildSearchIndex, fold, queryTerms, searchDocs, snippetOf, type SearchSource } from "../src/lib/docs/search";

const SOURCES: SearchSource[] = [
  {
    href: "/docs/concepts/prepaid-vouchers",
    title: "Prepaid vouchers",
    section: "Concepts",
    sections: [
      { id: null, heading: null, text: "An agent makes one shielded deposit per window and signs a voucher per call." },
      { id: "the-trust-ramp", heading: "The trust ramp", text: "Unconfirmed deposits earn credit as they confirm." },
      {
        id: "cumulative-totals",
        heading: "Cumulative totals",
        text: "Each voucher carries the running total in zat.",
        extra: "cumulativeZat signVoucher",
      },
    ],
  },
  {
    href: "/docs/reference/facilitator-api",
    title: "Facilitator API",
    section: "Reference",
    sections: [
      { id: null, heading: null, text: "The facilitator verifies and settles each call." },
      { id: "post-providers", heading: "POST /providers", text: "Registers a provider and answers with an API key." },
      { id: "get-providersme", heading: "GET /providers/me", text: "Checks an API key and its payTo." },
    ],
  },
  {
    href: "/docs/faq",
    title: "FAQ",
    section: "Help",
    sections: [{ id: "is-it-private", heading: "Is it private?", text: "Deposits are shielded; the voucher never reaches the chain." }],
  },
];

const index = buildSearchIndex(SOURCES);

describe("buildSearchIndex", () => {
  test("keeps one record per section, pointing at its page", () => {
    expect(index.v).toBe(1);
    expect(index.pages).toHaveLength(3);
    expect(index.records).toHaveLength(7);
    expect(index.records[4]).toEqual({
      p: 1,
      a: "post-providers",
      h: "POST /providers",
      t: "Registers a provider and answers with an API key.",
    });
  });

  test("gives a page without text one record, so its title is still found", () => {
    const empty = buildSearchIndex([{ href: "/docs/x", title: "Empty page", section: "Help", sections: [] }]);
    expect(searchDocs(empty, "empty")[0]).toMatchObject({ href: "/docs/x", heading: null });
  });

  test("keeps what is found but not quoted apart, and leaves it out when empty", () => {
    expect(index.records[2]?.x).toBe("cumulativeZat signVoucher");
    expect("x" in (index.records[0] ?? {})).toBe(false);
  });

  test("survives JSON, as it is served", () => {
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });
});

describe("queryTerms and fold", () => {
  test("splits on spaces and punctuation, lower case, without accents or repeats", () => {
    expect(queryTerms("  Trust RAMP, trust ")).toEqual(["trust", "ramp"]);
    expect(queryTerms("@z402/client")).toEqual(["@z402/client"]);
    expect(queryTerms("“quoted”")).toEqual(["“quoted”"]);
    expect(fold("Café ZCASH")).toBe("cafe zcash");
    expect(queryTerms("")).toEqual([]);
  });
});

describe("searchDocs", () => {
  test("puts a heading match before a text match", () => {
    const hits = searchDocs(index, "trust ramp");
    expect(hits[0]).toMatchObject({ href: "/docs/concepts/prepaid-vouchers#the-trust-ramp", heading: "The trust ramp" });
  });

  test("needs every term somewhere in the page title, heading or text", () => {
    expect(searchDocs(index, "voucher shielded").map((h) => h.href)).toEqual([
      "/docs/concepts/prepaid-vouchers",
      "/docs/faq#is-it-private",
    ]);
    expect(searchDocs(index, "voucher bananas")).toEqual([]);
  });

  test("finds a page by its title, linking the page itself", () => {
    expect(searchDocs(index, "facilitator api")[0]).toMatchObject({ href: "/docs/reference/facilitator-api", heading: null });
  });

  test("matches the start of a word, as typed so far", () => {
    expect(searchDocs(index, "provid")[0]?.heading).toBe("POST /providers");
  });

  test("finds a name from a code block but quotes the prose", () => {
    const [hit] = searchDocs(index, "cumulativezat");
    expect(hit?.href).toBe("/docs/concepts/prepaid-vouchers#cumulative-totals");
    expect(hit?.snippet.map((p) => p.text).join("")).toBe("Each voucher carries the running total in zat.");
  });

  test("names the page and its section on each hit", () => {
    expect(searchDocs(index, "private")[0]).toMatchObject({ page: "FAQ", section: "Help" });
  });

  test("returns nothing for an empty query and respects the limit", () => {
    expect(searchDocs(index, "   ")).toEqual([]);
    expect(searchDocs(index, "a", 2)).toHaveLength(2);
  });
});

describe("snippetOf", () => {
  test("marks every term in the window", () => {
    const parts = snippetOf("Each voucher carries the running total in zat.", ["voucher", "total"]);
    expect(parts).toEqual([
      { text: "Each ", mark: false },
      { text: "voucher", mark: true },
      { text: " carries the running ", mark: false },
      { text: "total", mark: true },
      { text: " in zat.", mark: false },
    ]);
  });

  test("starts near a term deep in the text and marks the cut with ellipses", () => {
    const text = `${"lorem ipsum ".repeat(20)}the facilitator settles ${"dolor sit ".repeat(20)}`;
    const parts = snippetOf(text, ["facilitator"]);
    expect(parts[0]?.text.startsWith("…")).toBe(true);
    expect(parts.at(-1)?.text.endsWith("…")).toBe(true);
    expect(parts.find((p) => p.mark)?.text).toBe("facilitator");
    expect(parts.map((p) => p.text).join("").length).toBeLessThan(160);
  });

  test("keeps the text's own case while matching without it", () => {
    expect(snippetOf("Zcash is shielded.", ["zcash"])[0]).toEqual({ text: "Zcash", mark: true });
  });
});
