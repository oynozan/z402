"use client";

import { useCopy } from "./use-copy";

const COMMAND = "npm install @z402/client";

function CopyGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.5 3.5V0.5H11.5V8.5H8.5" />
      <rect x="0.5" y="3.5" width="8" height="8" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M1.5 6.5L4.5 9.5L10.5 2.5" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

export function InstallCommand() {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className="cmd"
      data-copied={copied || undefined}
      aria-label={`Copy ${COMMAND}`}
      onClick={() => void copy(COMMAND)}
    >
      <code>
        <span className="cmd-verb">npm install</span> @z402/client
      </code>
      <span className="copy-cell" aria-hidden="true">
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
