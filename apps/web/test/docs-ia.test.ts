import { describe, expect, test } from "vitest";
import {
  DOC_PAGES,
  DOCS_SECTIONS,
  HIDDEN_PAGES,
  docCrumbs,
  docNeighbours,
  docsNav,
  findDocByHref,
  findDocPage,
  hrefOfSlug,
  slugOfFile,
} from "../src/lib/docs/ia";

const all = new Set([...DOC_PAGES, ...HIDDEN_PAGES].map((p) => p.file));
const page = (file: string) => {
  const found = [...DOC_PAGES, ...HIDDEN_PAGES].find((p) => p.file === file);
  if (found === undefined) throw new Error(`no page ${file}`);
  return found;
};

describe("the IA", () => {
  test("lists the sections in the sidebar's order", () => {
    expect(DOCS_SECTIONS.map((s) => s.label)).toEqual([
      "Overview",
      "Concepts",
      "Guides",
      "Starter services",
      "Reference",
      "Help",
    ]);
    expect(DOC_PAGES).toHaveLength(30);
  });

  test("gives every page one URL, and no two pages the same", () => {
    const hrefs = [...DOC_PAGES, ...HIDDEN_PAGES].map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const p of DOC_PAGES) {
      expect(p.href).toMatch(/^\/docs(\/[a-z0-9-]+)*$/);
      expect(p.title.trim()).not.toBe("");
    }
  });

  test("drops a trailing index from the URL", () => {
    expect(slugOfFile("index")).toBe("");
    expect(slugOfFile("services/index")).toBe("services");
    expect(slugOfFile("concepts/x402")).toBe("concepts/x402");
    expect(hrefOfSlug("")).toBe("/docs");
    expect(hrefOfSlug("services")).toBe("/docs/services");
    expect(page("services/index").href).toBe("/docs/services");
    expect(page("index").href).toBe("/docs");
  });

  test("finds a page from the catch-all's segments or from its URL", () => {
    expect(findDocPage(undefined)?.file).toBe("index");
    expect(findDocPage([])?.file).toBe("index");
    expect(findDocPage(["concepts", "x402"])?.title).toBe("x402 and HTTP 402");
    expect(findDocPage(["services"])?.file).toBe("services/index");
    expect(findDocPage(["components"])?.hidden).toBe(true);
    expect(findDocPage(["services", "index"])).toBeNull();
    expect(findDocPage(["nope"])).toBeNull();
    expect(findDocByHref("/docs/reference/client#install")?.title).toBe("@z402-net/client");
    expect(findDocByHref("/docs/")?.file).toBe("index");
    expect(findDocByHref("/services")).toBeNull();
  });

  test("keeps the components page out of the sidebar and the page order", () => {
    expect(DOC_PAGES.some((p) => p.file === "components")).toBe(false);
    const nav = docsNav(all);
    expect(nav.flatMap((s) => s.pages).some((p) => p.hidden)).toBe(false);
    expect(docNeighbours(page("components"), all)).toEqual({ prev: null, next: null });
  });
});

describe("docsNav", () => {
  test("leaves out pages that have no file, and a section left empty", () => {
    const available = new Set(["index", "quickstart", "concepts/x402", "faq"]);
    const nav = docsNav(available);
    expect(nav.map((s) => s.label)).toEqual(["Overview", "Concepts", "Help"]);
    expect(nav[0]?.pages.map((p) => p.title)).toEqual(["Overview", "Quickstart"]);
  });
});

describe("docNeighbours", () => {
  test("follows the sidebar's order across sections", () => {
    const { prev, next } = docNeighbours(page("concepts/x402"), all);
    expect(prev?.file).toBe("how-it-works");
    expect(next?.file).toBe("concepts/shielded-payments");
  });

  test("has no previous page at the start and no next at the end", () => {
    expect(docNeighbours(page("index"), all).prev).toBeNull();
    expect(docNeighbours(page("references"), all).next).toBeNull();
  });

  test("skips pages that have no file", () => {
    const available = new Set(["index", "concepts/x402", "faq"]);
    expect(docNeighbours(page("concepts/x402"), available)).toMatchObject({
      prev: { file: "index" },
      next: { file: "faq" },
    });
  });
});

describe("docCrumbs", () => {
  test("names the section, and links it only to a section page that exists", () => {
    expect(docCrumbs(page("index"), all)).toEqual([{ label: "Docs", href: "/docs" }]);
    expect(docCrumbs(page("quickstart"), all)).toEqual([{ label: "Docs", href: "/docs" }]);
    expect(docCrumbs(page("concepts/x402"), all)).toEqual([
      { label: "Docs", href: "/docs" },
      { label: "Concepts", href: null },
    ]);
    expect(docCrumbs(page("services/llm"), all)[1]).toEqual({ label: "Starter services", href: "/docs/services" });
    expect(docCrumbs(page("services/llm"), new Set(["services/llm"]))[1]?.href).toBeNull();
    expect(docCrumbs(page("services/index"), all)[1]?.href).toBeNull();
  });
});
