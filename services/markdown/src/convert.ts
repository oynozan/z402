/**
 * A page body to { title, byline, markdown } (design §4.2): jsdom on the final URL (scripts never run, nothing else is
 * loaded), @mozilla/readability for the main content with the whole body as the fallback, links and images made
 * absolute, then turndown.
 *
 * This module is also the entry of the conversion workers (convert-pool.ts), which may load it without tsx through
 * Node's own type stripping. That is why it imports nothing of its own at run time and uses only erasable syntax.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

export interface PageInput {
  finalUrl: string;
  /** "text/html", "application/xhtml+xml" or "text/plain" */
  contentType: string;
  charset: string | undefined;
  body: Uint8Array;
}

export interface ConvertLimits {
  /** Largest markdown answer in UTF-8 bytes; a longer one is cut and marked truncated */
  maxMarkdownBytes: number;
  /** Start tags a page may have (see maxTagsFor) */
  maxTags: number;
}

export interface Converted {
  title: string | null;
  byline: string | null;
  markdown: string;
  /** The page had more than the answer holds */
  truncated: boolean;
}

/** A page too heavy to convert, which the service refuses as too_large */
export class TooComplexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TooComplexError";
  }
}

/**
 * The start tags a page may have for a worker heap of `heapMb`, which bounds the parse before it starts. jsdom itself
 * takes about 64 MB, and the densest page shapes need about 3.4 KB per tag on top; measured at 192, 256 and 320 MB.
 * Large real pages have far fewer tags than the default allows (Wikipedia's longest articles about 22,000).
 */
export function maxTagsFor(heapMb: number): number {
  return Math.max(1_000, Math.floor((heapMb - 64) * 300));
}

/** Element nesting allowed; Blink's parser stops nesting at the same depth, and real pages stay under 40 */
export const MAX_DEPTH = 512;
/**
 * Readability's cost grows steeply with depth (511 nested elements keep it busy for seconds) and with size, so a
 * document deeper or larger than this goes straight to the body.
 */
const READABILITY_MAX_DEPTH = 64;
const READABILITY_MAX_ELEMENTS = 40_000;
/** turndown slows down with the size of what it converts, so it gets the page in groups of about this much text */
const GROUP_CHARS = 16_384;
/** A longer list is converted as several lists of this many items, numbered on */
const LIST_ITEMS_PER_BLOCK = 500;

const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
const IMAGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);
const DROPPED = "script, style, noscript, template, iframe, form";
/**
 * Elements whose markdown is nothing but their block children's, one after another, so those children can be converted
 * in groups. That holds for the table elements too, since turndown without a table plugin turns them into plain blocks.
 */
const TRANSPARENT: ReadonlySet<string> = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BODY", "CENTER", "DIV", "DL", "FOOTER", "HEADER", "HGROUP", "MAIN", "NAV", "SECTION",
  "TABLE", "TBODY", "TFOOT", "THEAD", "TR",
]);
/** turndown's block elements */
const BLOCKS: ReadonlySet<string> = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "AUDIO", "BLOCKQUOTE", "BODY", "CANVAS", "CENTER", "DD", "DIR", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "FRAMESET", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HGROUP", "HR", "HTML", "ISINDEX", "LI", "MAIN", "MENU", "NAV", "NOFRAMES", "NOSCRIPT", "OL", "OUTPUT", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const META_CHARSET_RE = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i;
const START_TAG_RE = /<[A-Za-z]/g;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_TEXT = 4;

function fence(code: string, language: string): string {
  let size = 3;
  for (const run of code.match(/^`{3,}/gm) ?? []) size = Math.max(size, run.length + 1);
  const marks = "`".repeat(size);
  return `\n\n${marks}${language}\n${code.replace(/\n$/, "")}\n${marks}\n\n`;
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "form"]);
// turndown fences only <pre><code>; a bare <pre> would come out as a paragraph with its line breaks lost
turndown.addRule("preformatted", {
  filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName !== "CODE",
  replacement: (_content, node) => fence(node.textContent ?? "", ""),
});

function encodingOf(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

function bomOf(body: Uint8Array): string | undefined {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  return undefined;
}

/** A byte order mark, else the Content-Type charset, else (HTML) a <meta> charset in the first 1 KB, else UTF-8 */
export function decodeBody(body: Uint8Array, charset: string | undefined, html: boolean): string {
  let encoding = bomOf(body) ?? encodingOf(charset);
  if (encoding === undefined && html) {
    const head = Buffer.from(body.buffer, body.byteOffset, Math.min(body.byteLength, 1024)).toString("latin1");
    const declared = encodingOf(META_CHARSET_RE.exec(head)?.[1]);
    // A page that could be read this far is ASCII-compatible, so a <meta> claiming UTF-16 means UTF-8 (HTML standard)
    encoding = declared === "utf-16le" || declared === "utf-16be" ? "utf-8" : declared;
  }
  return new TextDecoder(encoding ?? "utf-8").decode(body);
}

/** At most `maxBytes` of UTF-8, cut at a character boundary */
function capUtf8(text: string, maxBytes: number): { markdown: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { markdown: text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { markdown: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function tooManyTags(html: string, max: number): boolean {
  START_TAG_RE.lastIndex = 0;
  for (let n = 0; START_TAG_RE.exec(html) !== null; ) {
    n += 1;
    if (n > max) return true;
  }
  return false;
}

function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text === "" ? null : text;
}

function absolute(value: string | null, base: string, schemes: ReadonlySet<string>): string | undefined {
  const raw = value?.trim() ?? "";
  if (raw === "") return undefined;
  try {
    const url = new URL(raw, base);
    return schemes.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Links and images become absolute; a link to another scheme keeps only its text and such an image goes */
function absolutize(root: Element, base: string): void {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = absolute(a.getAttribute("href"), base, LINK_SCHEMES);
    if (href === undefined) a.removeAttribute("href");
    else a.setAttribute("href", href);
  }
  for (const img of root.querySelectorAll("img")) {
    const src = absolute(img.getAttribute("src"), base, IMAGE_SCHEMES);
    if (src === undefined) img.remove();
    else img.setAttribute("src", src);
  }
}

/** Drops everything after the first `limit` characters of text, so that turndown never converts much more than fits */
function cutAfter(root: Element, limit: number): boolean {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node !== null) {
    seen += node.nodeValue?.length ?? 0;
    if (seen > limit) break;
    node = walker.nextNode();
  }
  if (node === null) return false;
  for (let current: Node | null = node; current !== null && current !== root; current = current.parentNode) {
    while (current.nextSibling !== null) current.nextSibling.remove();
  }
  return true;
}

function splittable(element: Element): boolean {
  if (!TRANSPARENT.has(element.nodeName)) return false;
  for (const child of element.childNodes) {
    const inline =
      child.nodeType === ELEMENT_NODE
        ? !BLOCKS.has(child.nodeName)
        : child.nodeType === TEXT_NODE && (child.nodeValue ?? "").trim() !== "";
    if (inline) return false;
  }
  return true;
}

/** A long list as several shorter ones, an ordered one numbered on through its start attribute */
function splitList(list: Element): Element[] {
  const items = [...list.children];
  if (items.length <= LIST_ITEMS_PER_BLOCK) return [list];
  const declared = Number.parseInt(list.getAttribute("start") ?? "", 10);
  const start = Number.isFinite(declared) ? declared : 1;
  const parts: Element[] = [];
  for (let i = 0; i < items.length; i += LIST_ITEMS_PER_BLOCK) {
    const part = list.cloneNode(false) as Element;
    if (list.nodeName === "OL") part.setAttribute("start", String(start + i));
    part.append(...items.slice(i, i + LIST_ITEMS_PER_BLOCK));
    parts.push(part);
  }
  return parts;
}

/** The blocks of `root` in document order, opening every container whose children are all blocks */
function blocksOf(root: Element): Element[] {
  const out: Element[] = [];
  const add = (element: Element): void => {
    if (splittable(element)) for (const child of [...element.children]) add(child);
    else if (element.nodeName === "UL" || element.nodeName === "OL") out.push(...splitList(element));
    else out.push(element);
  };
  add(root);
  return out;
}

/** How many levels below `root` its deepest element sits, counting no further than `cap`, without recursion */
function depthOf(root: Element, cap: number): number {
  let node = root;
  let depth = 0;
  let deepest = 0;
  for (;;) {
    const child = node.firstElementChild;
    if (child !== null) {
      depth += 1;
      deepest = Math.max(deepest, depth);
      if (deepest >= cap) return deepest;
      node = child;
      continue;
    }
    for (;;) {
      if (node === root) return deepest;
      const sibling = node.nextElementSibling;
      if (sibling !== null) {
        node = sibling;
        break;
      }
      const parent = node.parentElement;
      if (parent === null) return deepest;
      node = parent;
      depth -= 1;
    }
  }
}

/**
 * turndown in groups of blocks, stopping once the answer is full. Converting a container is the same as converting
 * its blocks one after the other and joining them with a blank line, and groups keep turndown's cost linear.
 */
function toMarkdown(root: Element, maxBytes: number): { markdown: string; truncated: boolean } {
  const document = root.ownerDocument;
  const blocks = blocksOf(root);
  const parts: string[] = [];
  let bytes = 0;
  let group = document.createElement("div");
  let groupChars = 0;
  const flush = (): void => {
    const part = turndown.turndown(group).trim();
    if (part !== "") {
      parts.push(part);
      bytes += Buffer.byteLength(part) + 2;
    }
    group = document.createElement("div");
    groupChars = 0;
  };
  for (const block of blocks) {
    if (bytes > maxBytes) return { markdown: parts.join("\n\n"), truncated: true };
    groupChars += block.textContent?.length ?? 0;
    group.append(block);
    if (groupChars >= GROUP_CHARS) flush();
  }
  if (group.childNodes.length > 0) flush();
  return { markdown: parts.join("\n\n"), truncated: false };
}

interface Article {
  title: string | null;
  byline: string | null;
  content: Element;
}

/** Readability's article, or undefined when it finds none or fails, in which case it may have changed the document */
function readArticle(document: Document): Article | undefined {
  try {
    const parsed = new Readability<Node>(document, { keepClasses: true, serializer: (node) => node }).parse();
    const content = parsed?.content;
    if (parsed === null || content === null || content === undefined || content.nodeType !== ELEMENT_NODE) {
      return undefined;
    }
    return { title: clean(parsed.title), byline: clean(parsed.byline), content: content as Element };
  } catch {
    return undefined;
  }
}

function parse(html: string, url: string): JSDOM {
  // A VirtualConsole that goes nowhere, since jsdom would otherwise print the page's CSS errors on our stderr
  return new JSDOM(html, { url, contentType: "text/html", virtualConsole: new VirtualConsole() });
}

/** Converts one page; throws TooComplexError for a page over limits.maxTags start tags or MAX_DEPTH levels deep */
export function convertPage(page: PageInput, limits: ConvertLimits): Converted {
  if (page.contentType === "text/plain") {
    const text = decodeBody(page.body, page.charset, false);
    return { title: null, byline: null, ...capUtf8(text, limits.maxMarkdownBytes) };
  }
  const html = decodeBody(page.body, page.charset, true);
  if (tooManyTags(html, limits.maxTags)) throw new TooComplexError(`the page has more than ${limits.maxTags} tags`);

  let dom = parse(html, page.finalUrl);
  try {
    const { document } = dom.window;
    const depth = depthOf(document.documentElement, MAX_DEPTH + 1);
    if (depth > MAX_DEPTH) throw new TooComplexError(`the page nests elements more than ${MAX_DEPTH} levels deep`);
    const base = document.baseURI;
    const pageTitle = clean(document.title);
    const readable =
      depth <= READABILITY_MAX_DEPTH && document.getElementsByTagName("*").length <= READABILITY_MAX_ELEMENTS;
    const article = readable ? readArticle(document) : undefined;
    let root: Element | undefined = article?.content;
    if (root === undefined) {
      if (readable) {
        // Readability found nothing but may have rearranged the document on the way
        dom.window.close();
        dom = parse(html, page.finalUrl);
      }
      root = dom.window.document.body ?? dom.window.document.documentElement;
    }
    for (const dropped of root.querySelectorAll(DROPPED)) dropped.remove();
    absolutize(root, base);
    // Twice the answer's size in text, which leaves room for the whitespace that turndown collapses
    const cut = cutAfter(root, 2 * limits.maxMarkdownBytes);
    const converted = toMarkdown(root, limits.maxMarkdownBytes);
    const capped = capUtf8(converted.markdown, limits.maxMarkdownBytes);
    return {
      title: article?.title ?? pageTitle,
      byline: article?.byline ?? null,
      markdown: capped.markdown,
      truncated: cut || converted.truncated || capped.truncated,
    };
  } finally {
    dom.window.close();
  }
}

/** workerData that starts this module as a conversion worker; convert-pool.ts passes the same string */
export const CONVERT_WORKER = "z402-markdown-convert";

export interface ConvertJob {
  id: number;
  page: PageInput;
  limits: ConvertLimits;
}

export type ConvertAnswer =
  | { id: number; ok: true; result: Converted }
  | { id: number; ok: false; tooComplex: boolean; message: string };

if (!isMainThread && workerData === CONVERT_WORKER && parentPort !== null) {
  const port = parentPort;
  port.on("message", (job: ConvertJob) => {
    let answer: ConvertAnswer;
    try {
      answer = { id: job.id, ok: true, result: convertPage(job.page, job.limits) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      answer = { id: job.id, ok: false, tooComplex: e instanceof TooComplexError, message };
    }
    port.postMessage(answer);
  });
  port.postMessage({ ready: true });
}
