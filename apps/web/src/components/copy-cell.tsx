"use client";

import { useCopy } from "./use-copy";

export function CopyCell({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      className="copy-btn"
      data-copied={copied || undefined}
      aria-label={`Copy ${label}`}
      onClick={() => void copy(text)}
    >
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
