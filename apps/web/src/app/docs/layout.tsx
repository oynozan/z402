import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsSearch, type SearchSuggestion } from "@/components/docs/search";
import { DocsMobileBar, DocsSidebar, type SideSection } from "@/components/docs/sidebar";
import { availableFiles } from "@/lib/docs/content";
import { DOC_PAGES, docsNav } from "@/lib/docs/ia";
import "./docs.css";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · z402 docs" },
};

/** What the search dialog offers before anything is typed */
const STARTERS = ["quickstart", "how-it-works", "guides/pay-from-an-agent", "guides/sell-an-api", "reference/facilitator-api"];

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const available = await availableFiles();
  const nav: SideSection[] = docsNav(available).map((section) => ({
    label: section.label,
    pages: section.pages.map((page) => ({ href: page.href, title: page.title })),
  }));
  const suggestions: SearchSuggestion[] = STARTERS.flatMap((file) => {
    const page = DOC_PAGES.find((p) => p.file === file);
    return page !== undefined && available.has(file)
      ? [{ href: page.href, title: page.title, section: page.section ?? "" }]
      : [];
  });

  return (
    <DocsSearch suggestions={suggestions}>
      <section className="section docs-section">
        <div className="frame docs">
          <DocsMobileBar nav={nav} />
          <aside className="docs-side">
            <div className="docs-side-inner">
              <DocsSidebar nav={nav} />
            </div>
          </aside>
          {children}
        </div>
      </section>
    </DocsSearch>
  );
}
