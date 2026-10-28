import type { MDXContent } from "mdx/types";
import { cache } from "react";
import { DOC_PAGES, HIDDEN_PAGES, type DocPage } from "./ia";

export interface TocItem {
  depth: 2 | 3;
  id: string;
  text: string;
}

export interface DocSearchSection {
  id: string | null;
  heading: string | null;
  /** The prose a search result quotes */
  text: string;
  /** What a search finds but never quotes: tooltips and the names in code blocks */
  extra: string;
}

/** What rehype-docs exports from every page, see src/lib/docs/mdx/rehype-docs.mjs */
export interface DocData {
  toc: TocItem[];
  sections: DocSearchSection[];
  markdown: string;
}

export interface DocMeta {
  title: string;
  description: string | null;
}

export interface LoadedDoc {
  page: DocPage;
  Content: MDXContent;
  meta: DocMeta;
  data: DocData;
}

interface DocModule {
  default: MDXContent;
  meta?: { title?: unknown; description?: unknown };
  docData?: Partial<DocData>;
}

function isMissingModule(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "MODULE_NOT_FOUND" || (typeof message === "string" && /cannot find module/i.test(message));
}

/**
 * A page's compiled MDX, or null when its file does not exist. Two patterns of one level each, so the bundler lists
 * exactly the files of src/content/docs and of its sections, and a missing file is a rejected import, not a failed
 * build. A page that fails to compile still fails the build.
 */
async function importDoc(file: string): Promise<DocModule | null> {
  const [dir, name, ...rest] = file.split("/");
  if (rest.length > 0 || dir === undefined) return null;
  try {
    return (await (name === undefined
      ? import(`@/content/docs/${dir}.mdx`)
      : import(`@/content/docs/${dir}/${name}.mdx`))) as DocModule;
  } catch (error) {
    if (isMissingModule(error)) return null;
    throw error;
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export const loadDoc = cache(async (page: DocPage): Promise<LoadedDoc | null> => {
  const mod = await importDoc(page.file);
  if (mod === null || typeof mod.default !== "function") return null;
  const data = mod.docData ?? {};
  return {
    page,
    Content: mod.default,
    meta: { title: textOrNull(mod.meta?.title) ?? page.title, description: textOrNull(mod.meta?.description) },
    data: {
      toc: Array.isArray(data.toc) ? data.toc : [],
      sections: Array.isArray(data.sections) ? data.sections : [],
      markdown: typeof data.markdown === "string" ? data.markdown : "",
    },
  };
});

/** The files of every page that exists, sidebar and hidden pages alike */
export const availableFiles = cache(async (): Promise<ReadonlySet<string>> => {
  const pages = [...DOC_PAGES, ...HIDDEN_PAGES];
  const found = await Promise.all(pages.map(async (page) => (await importDoc(page.file)) !== null));
  return new Set(pages.filter((_, i) => found[i]).map((page) => page.file));
});

let warned = false;

/** One warning per process for the sidebar pages that have no file yet, which the docs leave out */
export function warnMissing(available: ReadonlySet<string>): void {
  if (warned) return;
  warned = true;
  const missing = DOC_PAGES.filter((page) => !available.has(page.file)).map((page) => `${page.file}.mdx`);
  if (missing.length === 0) return;
  console.warn(
    `[docs] ${missing.length} sidebar page${missing.length === 1 ? " has" : "s have"} no file in src/content/docs yet and ${missing.length === 1 ? "is" : "are"} left out: ${missing.join(", ")}`,
  );
}
