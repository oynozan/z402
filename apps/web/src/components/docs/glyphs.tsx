/** The docs' small glyphs, drawn like the copy glyph: 12px, one-pixel strokes, square ends */

const BOX = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", "aria-hidden": true } as const;

export function LinkGlyph() {
  return (
    <svg {...BOX} className="glyph">
      <path d="M5 7L7 5" />
      <path d="M4.5 5.5L2.5 7.5A2.12 2.12 0 0 0 4.5 9.5L6.5 7.5" />
      <path d="M5.5 4.5L7.5 2.5A2.12 2.12 0 0 1 9.5 4.5L7.5 6.5" />
    </svg>
  );
}

/** An arrow up and to the right, after a link that leaves the site */
export function OutGlyph() {
  return (
    <svg {...BOX} width="10" height="10" className="glyph glyph-out">
      <path d="M3.5 1.5H10.5V8.5" />
      <path d="M10.5 1.5L1.5 10.5" />
    </svg>
  );
}

export function ArrowGlyph({ back = false }: { back?: boolean }) {
  return (
    <svg {...BOX} className="glyph" style={back ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M1 6H11" />
      <path d="M6.5 1.5L11 6L6.5 10.5" />
    </svg>
  );
}

export function ChevronGlyph() {
  return (
    <svg {...BOX} className="glyph glyph-chevron">
      <path d="M2.5 4.5L6 8L9.5 4.5" />
    </svg>
  );
}

export function SearchGlyph() {
  return (
    <svg {...BOX} className="glyph">
      <rect x="1.5" y="1.5" width="7" height="7" />
      <path d="M8.5 8.5L11 11" />
    </svg>
  );
}

export function CloseGlyph() {
  return (
    <svg {...BOX} className="glyph">
      <path d="M2 2L10 10" />
      <path d="M10 2L2 10" />
    </svg>
  );
}

export type CalloutKind = "note" | "tip" | "warning" | "privacy";

/** A mark for each kind of callout: an i, a spark, a bang in a triangle and a closed shield */
export function CalloutGlyph({ kind }: { kind: CalloutKind }) {
  switch (kind) {
    case "tip":
      return (
        <svg {...BOX} className="glyph">
          <path d="M6 0.5V3.5M6 8.5V11.5M0.5 6H3.5M8.5 6H11.5" />
          <path d="M2.5 2.5L4 4M8 8L9.5 9.5M9.5 2.5L8 4M4 8L2.5 9.5" />
        </svg>
      );
    case "warning":
      return (
        <svg {...BOX} className="glyph">
          <path d="M6 1L11.25 10.5H0.75Z" strokeLinejoin="miter" />
          <path d="M6 4.5V7.5M6 8.5V9.25" />
        </svg>
      );
    case "privacy":
      return (
        <svg {...BOX} className="glyph">
          <path d="M6 0.75L10.5 2.5V6C10.5 8.5 8.5 10.25 6 11.25C3.5 10.25 1.5 8.5 1.5 6V2.5Z" strokeLinejoin="miter" />
          <path d="M4 6L5.5 7.5L8.25 4.5" />
        </svg>
      );
    default:
      return (
        <svg {...BOX} className="glyph">
          <rect x="0.5" y="0.5" width="11" height="11" />
          <path d="M6 5V9M6 3V3.75" />
        </svg>
      );
  }
}

export function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className="glyph">
      <path d="M3 1.5L12 7L3 12.5Z" />
    </svg>
  );
}
