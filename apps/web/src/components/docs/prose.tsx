import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { LinkGlyph, OutGlyph } from "./glyphs";

/** Markdown's own elements as the docs draw them */

type HeadingProps = ComponentPropsWithoutRef<"h2">;

/** A heading with its id from rehype-slug and a link to itself that shows on hover or focus */
function heading(Tag: "h2" | "h3" | "h4", className: string) {
  function Heading({ id, children, ...rest }: HeadingProps) {
    if (id === undefined) {
      return (
        <Tag className={className} {...rest}>
          {children}
        </Tag>
      );
    }
    return (
      <Tag id={id} className={className} {...rest}>
        {children}
        <a className="md-anchor" href={`#${id}`} aria-label="Link to this section">
          <LinkGlyph />
        </a>
      </Tag>
    );
  }
  Heading.displayName = Tag;
  return Heading;
}

export const H2 = heading("h2", "md-h2");
export const H3 = heading("h3", "md-h3");
export const H4 = heading("h4", "md-h4");

/** A "#" heading is the page title's place, so one in a page is drawn as a section heading instead */
export const H1 = heading("h2", "md-h2");

export function Anchor({ href = "", children, ...rest }: ComponentPropsWithoutRef<"a">) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link className="md-link" href={href} {...rest}>
        {children}
      </Link>
    );
  }
  if (/^https?:\/\//i.test(href) || href.startsWith("//")) {
    return (
      <a className="md-link md-link-out" href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
        <OutGlyph />
      </a>
    );
  }
  return (
    <a className="md-link" href={href} {...rest}>
      {children}
    </a>
  );
}

export function InlineCode({ children, className, ...rest }: ComponentPropsWithoutRef<"code">) {
  return (
    <code className={className === undefined ? "md-code" : `md-code ${className}`} {...rest}>
      {children}
    </code>
  );
}

/** A table scrolls sideways inside its frame on a narrow screen */
export function Table({ children, ...rest }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="md-table" tabIndex={0} role="region" aria-label="Table">
      <table {...rest}>{children}</table>
    </div>
  );
}

export function Blockquote({ children }: { children?: ReactNode }) {
  return <blockquote className="md-quote">{children}</blockquote>;
}
