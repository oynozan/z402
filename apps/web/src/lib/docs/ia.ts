/**
 * The docs' information architecture: the only place that holds the order and the titles of the pages. The sidebar,
 * the previous and next links, the search index and the static params all read it. A page's file is its path under
 * src/content/docs without ".mdx", and its URL drops a trailing "index", so "services/index" is /docs/services.
 */

export interface DocEntry {
  readonly file: string;
  readonly title: string;
}

export interface DocSection {
  readonly label: string;
  readonly pages: readonly DocEntry[];
}

export interface DocPage {
  readonly file: string;
  /** The URL path after /docs, "" for /docs itself */
  readonly slug: string;
  readonly href: string;
  /** The sidebar's title, which may be shorter than the page's own meta.title */
  readonly title: string;
  /** The label of the sidebar section, null for a page outside the sidebar */
  readonly section: string | null;
  readonly hidden: boolean;
}

export const DOCS_SECTIONS = [
  {
    label: "Overview",
    pages: [
      { file: "index", title: "Overview" },
      { file: "quickstart", title: "Quickstart" },
      { file: "how-it-works", title: "How it works" },
    ],
  },
  {
    label: "Concepts",
    pages: [
      { file: "concepts/x402", title: "x402 and HTTP 402" },
      { file: "concepts/shielded-payments", title: "Shielded payments" },
      { file: "concepts/prepaid-vouchers", title: "Prepaid vouchers" },
      { file: "concepts/providers", title: "Providers and API keys" },
      { file: "concepts/discovery", title: "Discovery" },
      { file: "concepts/privacy", title: "Privacy model" },
    ],
  },
  {
    label: "Guides",
    pages: [
      { file: "guides/pay-from-an-agent", title: "Pay from an agent" },
      { file: "guides/sell-an-api", title: "Sell an API" },
      { file: "guides/service-kit", title: "Build with the service kit" },
      { file: "guides/run-a-facilitator", title: "Run the facilitator" },
      { file: "guides/deploy-with-docker", title: "Deploy with Docker" },
    ],
  },
  {
    label: "Starter services",
    pages: [
      { file: "services/index", title: "Overview" },
      { file: "services/llm", title: "LLM inference" },
      { file: "services/markdown", title: "URL to markdown" },
      { file: "services/embeddings", title: "Text embeddings" },
      { file: "services/dropbox", title: "Encrypted drop box" },
    ],
  },
  {
    label: "Reference",
    pages: [
      { file: "reference/protocol", title: "Protocol" },
      { file: "reference/facilitator-api", title: "Facilitator API" },
      { file: "reference/client", title: "@z402-net/client" },
      { file: "reference/server", title: "@z402-net/server" },
      { file: "reference/service-kit", title: "@z402-net/service-kit" },
      { file: "reference/configuration", title: "Configuration" },
      { file: "reference/errors", title: "Errors and reason codes" },
      { file: "reference/glossary", title: "Glossary" },
    ],
  },
  {
    label: "Help",
    pages: [
      { file: "faq", title: "FAQ" },
      { file: "troubleshooting", title: "Troubleshooting" },
      { file: "references", title: "Further reading" },
    ],
  },
] as const satisfies readonly DocSection[];

/** Pages that render at their URL but stay out of the sidebar, the search, the sitemap and the page order */
export const HIDDEN_DOCS = [{ file: "components", title: "Components" }] as const satisfies readonly DocEntry[];

export const DOCS_ROOT = "/docs";

export function slugOfFile(file: string): string {
  if (file === "index") return "";
  return file.endsWith("/index") ? file.slice(0, -"/index".length) : file;
}

export function hrefOfSlug(slug: string): string {
  return slug === "" ? DOCS_ROOT : `${DOCS_ROOT}/${slug}`;
}

function page(entry: DocEntry, section: string | null, hidden: boolean): DocPage {
  const slug = slugOfFile(entry.file);
  return { file: entry.file, slug, href: hrefOfSlug(slug), title: entry.title, section, hidden };
}

/** Every sidebar page in reading order */
export const DOC_PAGES: readonly DocPage[] = DOCS_SECTIONS.flatMap((section) =>
  section.pages.map((entry) => page(entry, section.label, false)),
);

export const HIDDEN_PAGES: readonly DocPage[] = HIDDEN_DOCS.map((entry) => page(entry, null, true));

const BY_SLUG = new Map<string, DocPage>([...DOC_PAGES, ...HIDDEN_PAGES].map((p) => [p.slug, p]));

/** The page at /docs/<parts joined by "/">, from the optional catch-all's segments */
export function findDocPage(parts: readonly string[] | undefined): DocPage | null {
  const slug = (parts ?? []).map((part) => decodeURIComponent(part)).join("/");
  return BY_SLUG.get(slug) ?? null;
}

export function findDocByHref(href: string): DocPage | null {
  const path = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (path !== DOCS_ROOT && !path.startsWith(`${DOCS_ROOT}/`)) return null;
  return BY_SLUG.get(path.slice(DOCS_ROOT.length + 1)) ?? null;
}

export interface NavSection {
  label: string;
  pages: DocPage[];
}

/** The sidebar: the sections in order with the pages that exist, and no empty section */
export function docsNav(available: ReadonlySet<string>): NavSection[] {
  return DOCS_SECTIONS.map((section) => ({
    label: section.label,
    pages: DOC_PAGES.filter((p) => p.section === section.label && available.has(p.file)),
  })).filter((section) => section.pages.length > 0);
}

/** The pages before and after one in reading order, skipping any that do not exist; none for a hidden page */
export function docNeighbours(
  current: DocPage,
  available: ReadonlySet<string>,
): { prev: DocPage | null; next: DocPage | null } {
  if (current.hidden) return { prev: null, next: null };
  const order = DOC_PAGES.filter((p) => available.has(p.file) || p.file === current.file);
  const at = order.findIndex((p) => p.file === current.file);
  return { prev: order[at - 1] ?? null, next: order[at + 1] ?? null };
}

export interface Crumb {
  label: string;
  href: string | null;
}

/**
 * The trail above a page's title: Docs, then the page's section, except for the first section, whose pages sit at
 * the top of /docs. A section links to its own index page, such as /docs/services, when it has one.
 */
export function docCrumbs(current: DocPage, available: ReadonlySet<string>): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Docs", href: DOCS_ROOT }];
  if (current.section === null || current.section === DOCS_SECTIONS[0].label) return crumbs;
  const root = DOC_PAGES.find((p) => p.section === current.section && p.file.endsWith("/index"));
  const linked = root !== undefined && root.file !== current.file && available.has(root.file);
  crumbs.push({ label: current.section, href: linked ? root.href : null });
  return crumbs;
}
