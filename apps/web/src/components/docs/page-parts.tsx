import Link from "next/link";
import { Fragment } from "react";
import type { Crumb, DocPage } from "@/lib/docs/ia";
import { ArrowGlyph } from "./glyphs";

/** The trail above the title, drawn as the site's section badge: chips joined by a tick */
export function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="badge crumbs">
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.label}>
            {i > 0 && <li className="tick" aria-hidden="true" />}
            <li>
              {crumb.href === null ? (
                <span className="chip">{crumb.label}</span>
              ) : (
                <Link className="chip crumb-link" href={crumb.href}>
                  {crumb.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

function PagerLink({ page, rel }: { page: DocPage | null; rel: "prev" | "next" }) {
  if (page === null) return <span className="pager-cell pager-empty" aria-hidden="true" />;
  return (
    <Link className="pager-cell pager-link" data-rel={rel} href={page.href} rel={rel}>
      <span className="pager-label">
        {rel === "prev" && <ArrowGlyph back />}
        {rel === "prev" ? "Previous" : "Next"}
        {rel === "next" && <ArrowGlyph />}
      </span>
      <span className="pager-title">{page.title}</span>
    </Link>
  );
}

/** The pages before and after this one in the sidebar's order */
export function Pager({ prev, next }: { prev: DocPage | null; next: DocPage | null }) {
  if (prev === null && next === null) return null;
  return (
    <nav className="pager" aria-label="Previous and next page">
      <PagerLink page={prev} rel="prev" />
      <PagerLink page={next} rel="next" />
    </nav>
  );
}
