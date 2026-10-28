"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CopyCell } from "@/components/copy";

/** The tab strip of a CodeTabs block: one tab a block, arrow keys move between them, the copy cell copies the shown one */
export function Tabs({ labels, codes, panels }: { labels: string[]; codes: (string | null)[]; panels: ReactNode[] }) {
  const [active, setActive] = useState(0);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const pick = (index: number) => {
    const next = (index + labels.length) % labels.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: labels.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    pick(to);
  };
  const code = codes[active] ?? null;

  return (
    <figure className="code code-tabs">
      <div className="code-bar">
        <div className="code-tablist" role="tablist" aria-label="Code">
          {labels.map((label, i) => (
            <button
              key={i}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${i}`}
              className="code-tab"
              aria-selected={i === active}
              aria-controls={`${base}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={onKeyDown}
            >
              {label}
            </button>
          ))}
        </div>
        {code !== null && <CopyCell text={code} label={labels[active] ?? "the code"} />}
      </div>
      {panels.map((panel, i) => (
        <div
          key={i}
          role="tabpanel"
          id={`${base}-panel-${i}`}
          aria-labelledby={`${base}-tab-${i}`}
          className="code-panel"
          hidden={i !== active}
        >
          {panel}
        </div>
      ))}
    </figure>
  );
}
