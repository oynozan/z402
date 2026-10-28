/**
 * The docs search: an index built once at build time from every sidebar page's sections, and a scorer that runs in
 * the browser over it. A record is one heading's section of one page, or the text before a page's first heading.
 */

export interface SearchSource {
  href: string;
  /** The page's title as the sidebar names it */
  title: string;
  /** Its sidebar section, such as "Concepts" */
  section: string;
  sections: readonly { id: string | null; heading: string | null; text: string; extra?: string }[];
}

export interface SearchIndex {
  v: 1;
  pages: { href: string; title: string; section: string }[];
  /**
   * p: the page's index in pages, a: the heading's anchor, h: the heading, t: the section's text, x: what is found but
   * not quoted, the tooltips and the names in its code, left out when there is none
   */
  records: { p: number; a: string | null; h: string | null; t: string; x?: string }[];
}

export function buildSearchIndex(sources: readonly SearchSource[]): SearchIndex {
  const pages: SearchIndex["pages"] = [];
  const records: SearchIndex["records"] = [];
  for (const source of sources) {
    const p = pages.push({ href: source.href, title: source.title, section: source.section }) - 1;
    const sections = source.sections.length > 0 ? source.sections : [{ id: null, heading: null, text: "" }];
    for (const section of sections) {
      const extra = section.extra ?? "";
      records.push({ p, a: section.id, h: section.heading, t: section.text, ...(extra === "" ? {} : { x: extra }) });
    }
  }
  return { v: 1, pages, records };
}

export interface SnippetPart {
  text: string;
  mark: boolean;
}

export interface SearchHit {
  href: string;
  page: string;
  section: string;
  heading: string | null;
  snippet: SnippetPart[];
  score: number;
}

/** Lower case without accents, so "Zcash" finds "zcash" and "café" finds "cafe", keeping each character's place */
export function fold(text: string): string {
  return Array.from(text, (ch) => ch.normalize("NFD").replace(/[̀-ͯ]/g, "") || ch)
    .join("")
    .toLowerCase();
}

export function queryTerms(query: string): string[] {
  const terms = fold(query)
    .split(/[\s,;:!?()[\]{}"'`<>|=+*]+/)
    .map((term) => term.replace(/^[.\-_/]+|[.\-_/]+$/g, ""))
    .filter((term) => term.length > 0);
  return [...new Set(terms)];
}

function isWordStart(text: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1] ?? "");
}

/** How well one field holds one term: 0 if it does not, more for a whole word and more again at the start */
function fieldScore(field: string, term: string): number {
  const at = field.indexOf(term);
  if (at === -1) return 0;
  let score = 1;
  if (isWordStart(field, at)) score += 1;
  const end = at + term.length;
  if (!/[\p{L}\p{N}]/u.test(field[end] ?? "")) score += 1;
  if (at === 0) score += 1;
  return score;
}

const SNIPPET_BEFORE = 36;
const SNIPPET_LENGTH = 150;

/** A window of the text around the first term it holds, every term in it marked */
export function snippetOf(text: string, terms: readonly string[]): SnippetPart[] {
  if (text === "") return [];
  const folded = fold(text);
  let first = -1;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  let start = first <= SNIPPET_BEFORE ? 0 : first - SNIPPET_BEFORE;
  if (first === -1) first = 0;
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > first) end = space;
  }

  const marks: [number, number][] = [];
  for (const term of terms) {
    let at = folded.indexOf(term, start);
    while (at !== -1 && at < end) {
      marks.push([at, Math.min(end, at + term.length)]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const parts: SnippetPart[] = [];
  const add = (slice: string, mark: boolean) => {
    if (slice === "") return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.mark === mark) last.text += slice;
    else parts.push({ text: slice, mark });
  };
  if (start > 0) add("…", false);
  let at = start;
  for (const [from, to] of marks) {
    if (to <= at) continue;
    add(text.slice(at, Math.max(at, from)), false);
    add(text.slice(Math.max(at, from), to), true);
    at = to;
  }
  add(text.slice(at, end), false);
  if (end < text.length) add("…", false);
  return parts;
}

const MAX_PER_PAGE = 3;

/**
 * The best sections for a query. Every term must appear in the page's title, the heading or the text. A term in a
 * heading counts most, then in the page's title, then in the text, and a page's own intro stands for the page.
 */
export function searchDocs(index: SearchIndex, query: string, limit = 20): SearchHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: { record: SearchIndex["records"][number]; order: number; score: number }[] = [];
  index.records.forEach((record, order) => {
    const page = index.pages[record.p];
    if (page === undefined) return;
    const title = fold(page.title);
    const heading = fold(record.h ?? "");
    const text = fold(record.x === undefined ? record.t : `${record.t} ${record.x}`);
    let score = 0;
    for (const term of terms) {
      const inHeading = fieldScore(heading, term);
      const inTitle = fieldScore(title, term);
      const inText = fieldScore(text, term);
      if (inHeading + inTitle + inText === 0) return;
      score += inHeading * 6 + inTitle * (record.a === null ? 5 : 2) + Math.min(inText, 3);
    }
    scored.push({ record, order, score });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const perPage = new Map<number, number>();
  const hits: SearchHit[] = [];
  for (const { record, score } of scored) {
    const count = perPage.get(record.p) ?? 0;
    if (count >= MAX_PER_PAGE) continue;
    perPage.set(record.p, count + 1);
    const page = index.pages[record.p]!;
    hits.push({
      href: record.a === null ? page.href : `${page.href}#${record.a}`,
      page: page.title,
      section: page.section,
      heading: record.h,
      snippet: snippetOf(record.t, terms),
      score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
