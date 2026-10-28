"use client";

import type { ReactNode } from "react";
import { useCopy } from "./use-copy";

function CopyGlyph() {
  return (
    <svg className="glyph-copy" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.5 3.5V0.5H11.5V8.5H8.5" />
      <rect x="0.5" y="3.5" width="8" height="8" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="glyph-check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M1.5 6.5L4.5 9.5L10.5 2.5" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function Announce({ copied }: { copied: boolean }) {
  return (
    <span className="sr-only" aria-live="polite">
      {copied ? "Copied" : ""}
    </span>
  );
}

/** A square cell whose glyph turns into a check once the text is on the clipboard */
export function CopyCell({ text, label, title }: { text: string; label: string; title?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className="copy-cell"
      title={title}
      data-copied={copied || undefined}
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(text);
      }}
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
      <Announce copied={copied} />
    </button>
  );
}

/** A labelled copy button, such as COPY CALL, that reads COPIED for a moment */
export function CopyButton({
  text,
  label,
  children,
  className = "",
}: {
  text: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className={`copy-btn ${className}`.trim()}
      data-copied={copied || undefined}
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        void copy(text);
      }}
    >
      <span aria-hidden="true">{copied ? "Copied" : children}</span>
      <Announce copied={copied} />
    </button>
  );
}
