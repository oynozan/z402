import { createHash } from "node:crypto";
import { render, type RenderOptions } from "pele";
import { manropeMeasurer } from "@/lib/docs/manrope";

/**
 * A ```mermaid fence, drawn to inline SVG by Pele when the page is built, so the page ships no diagram code. Pele
 * colors it with CSS variables that docs.css maps to the site's tokens. A diagram is fitted to the prose column;
 * when it is wider than a phone's column a second, narrower drawing is made, and the frame shows whichever fits. A
 * diagram still wider than its frame scrolls inside it. A syntax error shows its message on the page in development
 * and fails the build.
 */

/** The prose column's 720px less the frame's 24px insets and its borders */
const WIDE = 670;
/** A 390px phone's column less the page's and the frame's 20px insets and the borders */
const NARROW = 308;

const BASE: RenderOptions = {
  fontSize: 14,
  measurer: manropeMeasurer,
  fontFamily: "Manrope, sans-serif",
  fontFamilyMono: "'IBM Plex Mono', monospace",
  responsive: false,
};

interface Drawing {
  svg: string;
  width: number;
}

function draw(source: string, idPrefix: string, maxWidth: number): Drawing {
  let result = render(source, { ...BASE, idPrefix, maxWidth });
  // A left-to-right flowchart too wide for the column is drawn top to bottom rather than scrolled
  if (result.width > maxWidth && result.type === "flowchart") {
    result = render(source, { ...BASE, idPrefix, maxWidth, autoDirection: true, directionBreakpoint: Number.MAX_SAFE_INTEGER });
  }
  return { svg: result.svg, width: result.width };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Mermaid({ source }: { source: string }) {
  const id = `mmd-${createHash("sha256").update(source).digest("hex").slice(0, 10)}`;
  let wide: Drawing;
  let narrow: Drawing | null = null;
  try {
    wide = draw(source, `${id}w`, WIDE);
    if (wide.width > NARROW) {
      // Kept only when it is narrower: a graph Pele cannot fold any further would be the same drawing twice
      const folded = draw(source, `${id}n`, NARROW);
      if (folded.width < wide.width) narrow = folded;
    }
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`A mermaid diagram does not render: ${messageOf(error)}\n\n${source}`);
    }
    return (
      <div className="diagram-error" role="alert">
        <p className="diagram-error-label">Mermaid error</p>
        <pre className="diagram-error-text">{messageOf(error)}</pre>
        <pre className="diagram-error-source">{source}</pre>
      </div>
    );
  }
  // The frame is the container: once it is narrower than the wide drawing and its 24px insets, it shows the narrow one
  const swap =
    narrow === null
      ? null
      : `@container (width < ${Math.ceil(wide.width) + 48}px) { #${id} .diagram-wide { display: none } #${id} .diagram-narrow { display: block } }`;
  return (
    <figure className="diagram" id={id}>
      {swap !== null && <style>{swap}</style>}
      <div className="diagram-scroll" tabIndex={0}>
        <div className="diagram-wide" dangerouslySetInnerHTML={{ __html: wide.svg }} />
        {narrow !== null && <div className="diagram-narrow" dangerouslySetInnerHTML={{ __html: narrow.svg }} />}
      </div>
    </figure>
  );
}
