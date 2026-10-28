import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import {
  convertPage,
  decodeBody,
  MAX_DEPTH,
  MAX_TITLE_BYTES,
  maxTagsFor,
  TooComplexError,
  type ConvertLimits,
  type PageInput,
} from "../src/convert.js";

const MiB = 1024 * 1024;
const LIMITS: ConvertLimits = { maxMarkdownBytes: MiB, maxTags: 60_000 };

function htmlPage(body: string | Uint8Array, o: Partial<PageInput> = {}): PageInput {
  return {
    finalUrl: "https://example.com/docs/guide/",
    contentType: "text/html",
    charset: undefined,
    body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
    ...o,
  };
}

const ARTICLE = `<!doctype html>
<html><head>
  <title>Writing Guide - Example Docs</title>
  <meta name="author" content="Ada Lovelace">
  <style>.STYLE_TEXT { color: red }</style>
  <script>window.SCRIPT_TEXT = document.title = "hacked";</script>
</head><body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <article>
    <h1>Writing Guide</h1>
    <p>Good documentation starts with a clear purpose. This guide explains how we write, review and publish pages,
    and why each step exists. Read the <a href="../other/page.html?x=1#part">related page</a>, write to
    <a href="mailto:docs@example.com">the docs team</a>, and never click <a href="javascript:alert(1)">this</a>.</p>
    <h2>Structure</h2>
    <p>Every page has a title, a short introduction and sections. Sections use second level headings, and each one
    answers a single question that a reader is likely to have when they arrive at the page.</p>
    <img src="img/diagram.png" alt="Diagram">
    <img src="data:image/png;base64,AAAA" alt="Inline">
    <h3>Lists</h3>
    <ul><li>one</li><li>two</li></ul>
    <pre><code class="language-js">const x = 1;
console.log(x);</code></pre>
    <pre>plain   preformatted
  text</pre>
    <p>Code fences inside code are lengthened: <code>inline</code> code stays inline.</p>
    <pre><code>\`\`\`
nested fence
\`\`\`</code></pre>
    <noscript>NOSCRIPT_TEXT</noscript>
    <form><input name="q" value="FORM_TEXT"><button>FORM_BUTTON</button></form>
    <iframe src="https://evil.example/"></iframe>
    <script>var s = "SCRIPT_BODY";</script>
  </article>
  <footer>Footer text</footer>
</body></html>`;

describe("convertPage on HTML", () => {
  const result = convertPage(htmlPage(ARTICLE), LIMITS);
  const md = result.markdown;

  test("title, byline and the main content", () => {
    expect(result.title).toBe("Writing Guide - Example Docs");
    expect(result.byline).toBe("Ada Lovelace");
    expect(result.truncated).toBe(false);
    expect(md).toContain("Good documentation starts with a clear purpose.");
    // Readability keeps the article and drops the navigation and the footer
    expect(md).not.toContain("Home");
    expect(md).not.toContain("Footer text");
  });

  test("atx headings", () => {
    expect(md).toMatch(/^## Structure$/m);
    expect(md).toMatch(/^### Lists$/m);
  });

  test("links and images are absolute, and other schemes are dropped", () => {
    expect(md).toContain("[related page](https://example.com/docs/other/page.html?x=1#part)");
    expect(md).toContain("[the docs team](mailto:docs@example.com)");
    expect(md).toContain("![Diagram](https://example.com/docs/guide/img/diagram.png)");
    expect(md).not.toContain("javascript:");
    expect(md).not.toContain("data:image");
  });

  test("fenced code blocks, with the language and a longer fence when the code holds one", () => {
    expect(md).toContain("```js\nconst x = 1;\nconsole.log(x);\n```");
    expect(md).toContain("```\nplain   preformatted\n  text\n```");
    expect(md).toContain("````\n```\nnested fence\n```\n````");
    expect(md).toContain("`inline`");
  });

  test("bullet lists use -", () => {
    expect(md).toMatch(/^- +one$/m);
    expect(md).toMatch(/^- +two$/m);
  });

  test("scripts never run, and scripts, styles, noscript, forms and iframes are gone", () => {
    const hidden = ["SCRIPT_TEXT", "SCRIPT_BODY", "STYLE_TEXT", "NOSCRIPT_TEXT", "FORM_TEXT", "FORM_BUTTON"];
    for (const text of [...hidden, "evil.example", "hacked"]) expect(md).not.toContain(text);
    expect(result.title).not.toBe("hacked");
  });

  test("nothing the page points at is loaded and no script or handler runs: no request leaves", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/css" }).end("body {}");
    });
    server.on("connection", () => hits.push("connection"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const o = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = `<html><head><title>t</title>
      <link rel="stylesheet" href="${o}/link"><link rel="preload" href="${o}/preload">
      <style>@import url("${o}/import"); body { background: url(${o}/background) }</style>
      <script src="${o}/script"></script><script>fetch("${o}/inline"); new Image().src = "${o}/image";</script>
      <meta http-equiv="refresh" content="0;url=${o}/refresh"></head>
      <body onload="fetch('${o}/onload')"><article><p>${"Words worth reading. ".repeat(30)}</p>
      <img src="${o}/img" srcset="${o}/srcset 2x"><img src="x" onerror="fetch('${o}/onerror')">
      <iframe src="${o}/iframe"></iframe><iframe srcdoc="<script>fetch('${o}/srcdoc')</script>"></iframe>
      <object data="${o}/object"></object><embed src="${o}/embed"><video poster="${o}/poster" src="${o}/video"></video>
      <svg><image href="${o}/svg"/></svg></article></body></html>`;
    try {
      const result = convertPage(htmlPage(page, { finalUrl: `${o}/page` }), LIMITS);
      expect(result.markdown).toContain("Words worth reading.");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  });

  test("a <base> element moves where relative links point", () => {
    const page = convertPage(
      htmlPage(`<html><head><base href="https://cdn.example.net/root/"></head><body><article>
        <p>${"Text with enough words to count as content for the reader view. ".repeat(10)}
        <a href="a/b">based link</a></p></article></body></html>`),
      LIMITS,
    );
    expect(page.markdown).toContain("[based link](https://cdn.example.net/root/a/b)");
  });
});

describe("convertPage fallbacks and limits", () => {
  test("a document Readability finds nothing in falls back to the body", () => {
    const empty = convertPage(htmlPage("<html><head><title> Only a title </title></head><body></body></html>"), LIMITS);
    expect(empty).toEqual({ title: "Only a title", byline: null, markdown: "", truncated: false });
  });

  test("a document too large for Readability is converted whole, navigation included", () => {
    const filler = "<span>w</span>".repeat(41_000);
    const page = convertPage(
      htmlPage(`<html><body><nav><a href="/nav">Navigation</a></nav><p>${filler}</p></body></html>`),
      LIMITS,
    );
    expect(page.markdown.startsWith("[Navigation](https://example.com/nav)")).toBe(true);
  });

  test("a page with more than maxTags start tags is refused before it is parsed", () => {
    const started = Date.now();
    // <html>, <body> and 1,000 paragraphs
    const page = htmlPage(`<html><body>${"<p>x".repeat(1_000)}</body></html>`);
    expect(() => convertPage(page, { ...LIMITS, maxTags: 1_001 })).toThrow(TooComplexError);
    expect(convertPage(page, { ...LIMITS, maxTags: 1_002 }).markdown.split("\n\n")).toHaveLength(1_000);
    expect(() => convertPage(htmlPage(`<body>${"<b>".repeat(LIMITS.maxTags + 1)}</body>`), LIMITS)).toThrow(
      TooComplexError,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("the tag budget grows with the worker heap", () => {
    expect(maxTagsFor(128)).toBe(19_200);
    expect(maxTagsFor(192)).toBe(38_400);
    expect(maxTagsFor(256)).toBe(57_600);
  });

  test("a page nested more than MAX_DEPTH levels deep is refused", () => {
    const deep = (levels: number): PageInput => htmlPage(`<html><body>${"<div>".repeat(levels)}deep</body></html>`);
    // Levels are counted below <html>, and <body> is the first of them
    const started = Date.now();
    expect(convertPage(deep(MAX_DEPTH - 1), LIMITS).markdown).toBe("deep");
    expect(() => convertPage(deep(MAX_DEPTH), LIMITS)).toThrow(TooComplexError);
    // A deep document skips Readability, whose cost grows steeply with depth
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a long ordered list is converted in parts and keeps counting", () => {
    const items = Array.from({ length: 1_200 }, (_, i) => `<li>item ${i + 1}</li>`).join("");
    const page = convertPage(htmlPage(`<html><body><ol start="5">${items}</ol></body></html>`), LIMITS);
    const numbers = [...page.markdown.matchAll(/^(\d+)\. +item (\d+)$/gm)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(numbers).toHaveLength(1_200);
    expect(numbers.every(([n, item]) => n === (item ?? 0) + 4)).toBe(true);
  });

  test("a large table becomes one block per cell, in order", () => {
    const rows = Array.from({ length: 3_000 }, (_, i) => `<tr><td>row ${i}</td><td>value ${i}</td></tr>`).join("");
    const page = convertPage(htmlPage(`<html><body><table><tbody>${rows}</tbody></table></body></html>`), LIMITS);
    const blocks = page.markdown.split("\n\n");
    expect(blocks).toHaveLength(6_000);
    expect(blocks.slice(0, 4)).toEqual(["row 0", "value 0", "row 1", "value 1"]);
    expect(blocks.at(-1)).toBe("value 2999");
  });

  test("the title and the byline are capped like the markdown, whichever way they are found", () => {
    const long = "Title words ".repeat(20_000);
    const article = `<article><p>${"Words worth reading for the reader view. ".repeat(20)}</p></article>`;
    const pages = [
      // The whole body as the fallback, with document.title
      `<html><head><title>${long}</title></head><body><p>x</p></body></html>`,
      // Readability's title and its byline from a <meta>
      `<html><head><title>${long}</title><meta name="author" content="${long}"></head><body>${article}</body></html>`,
    ];
    for (const page of pages) {
      const result = convertPage(htmlPage(page), { ...LIMITS, maxMarkdownBytes: 1024 });
      expect(Buffer.byteLength(result.title ?? "")).toBeGreaterThan(MAX_TITLE_BYTES - 16);
      expect(Buffer.byteLength(result.title ?? "")).toBeLessThanOrEqual(MAX_TITLE_BYTES);
      expect(Buffer.byteLength(result.byline ?? "")).toBeLessThanOrEqual(MAX_TITLE_BYTES);
    }
    const byline = convertPage(htmlPage(pages[1] ?? ""), LIMITS).byline ?? "";
    expect(Buffer.byteLength(byline)).toBeGreaterThan(MAX_TITLE_BYTES - 16);
    // Cut at a character boundary
    const wide = convertPage(htmlPage(`<html><head><title>${"é".repeat(5_000)}</title></head></html>`), LIMITS);
    expect(wide.title).toBe("é".repeat(MAX_TITLE_BYTES / 2));
  });

  test("the markdown is capped in bytes and marked truncated", () => {
    const paragraph = "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>";
    const paragraphs = paragraph.repeat(3_000);
    const page = convertPage(htmlPage(`<html><body><article>${paragraphs}</article></body></html>`), {
      ...LIMITS,
      maxMarkdownBytes: 10_000,
    });
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(page.markdown)).toBeLessThanOrEqual(10_000);
    expect(page.markdown.startsWith("Lorem ipsum dolor sit amet")).toBe(true);
  });
});

describe("text/plain and charsets", () => {
  test("text/plain becomes the markdown as it is", () => {
    const text = "# not a heading\n<b>raw</b> & more\n";
    expect(convertPage(htmlPage(text, { contentType: "text/plain" }), LIMITS)).toEqual({
      title: null,
      byline: null,
      markdown: text,
      truncated: false,
    });
  });

  test("the cap never splits a character", () => {
    const text = htmlPage("é".repeat(3_000), { contentType: "text/plain" });
    const page = convertPage(text, { ...LIMITS, maxMarkdownBytes: 1_001 });
    expect(page).toMatchObject({ markdown: "é".repeat(500), truncated: true });
  });

  test("the Content-Type charset decodes the page", () => {
    const latin1 = Buffer.from("<p>caf\xe9 na\xefve</p>", "latin1");
    expect(decodeBody(latin1, "iso-8859-1", true)).toBe("<p>café naïve</p>");
    expect(convertPage(htmlPage(latin1, { charset: "iso-8859-1" }), LIMITS).markdown).toBe("café naïve");
  });

  test("a <meta> charset decodes the page when the header has none", () => {
    const cp1251 = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>', "latin1"),
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      Buffer.from("</p></body></html>", "latin1"),
    ]);
    expect(convertPage(htmlPage(cp1251), LIMITS).markdown).toBe("Привет");
    const httpEquiv = Buffer.from(
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>na\xefve</p>',
      "latin1",
    );
    expect(decodeBody(httpEquiv, undefined, true)).toContain("naïve");
  });

  test("a byte order mark wins over the header, and UTF-8 is the default", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>café</p>", "utf8")]);
    expect(decodeBody(bom, "iso-8859-1", true)).toBe("<p>café</p>");
    expect(decodeBody(Buffer.from("<p>café</p>", "utf8"), undefined, true)).toBe("<p>café</p>");
    expect(decodeBody(Buffer.from("<p>café</p>", "utf8"), "no-such-charset", true)).toBe("<p>café</p>");
  });
});
