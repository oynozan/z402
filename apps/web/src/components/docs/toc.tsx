"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TocItem } from "@/lib/docs/content";
import { ChevronGlyph } from "./glyphs";

/** How far below the top of the window a heading counts as reached: the sticky header and a little air */
const READ_LINE = 96;

/** The id of the last heading that has scrolled past the read line, or the first heading before any has */
function useActiveHeading(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (ids.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el === null) continue;
        if (el.getBoundingClientRect().top <= READ_LINE) current = id;
        else break;
      }
      // At the very bottom the last headings may never reach the line, so the last one wins
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = ids[ids.length - 1] ?? current;
      setActive(current);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("hashchange", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  return active;
}

function TocList({ items, active, follow = false }: { items: TocItem[]; active: string | null; follow?: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);

  // In the rail, a list taller than the window scrolls itself, never the page, to keep the current heading in view
  useEffect(() => {
    if (!follow || active === null) return;
    const box = listRef.current?.closest<HTMLElement>(".doc-rail-inner");
    const link = listRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (box == null || link == null || box.scrollHeight <= box.clientHeight) return;
    const view = box.getBoundingClientRect();
    const at = link.getBoundingClientRect();
    if (at.top >= view.top + 48 && at.bottom <= view.bottom - 48) return;
    box.scrollTop += at.top - view.top - (view.height - at.height) / 2;
  }, [active, follow]);

  return (
    <ol className="toc-list" ref={listRef}>
      {items.map((item) => (
        <li key={item.id} data-depth={item.depth}>
          <a className="toc-link" href={`#${item.id}`} aria-current={item.id === active ? "location" : undefined}>
            {item.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** "On this page": a sticky list in the right column on a wide screen, folded into the top of the page otherwise */
export function DocsToc({ items, variant }: { items: TocItem[]; variant: "rail" | "fold" }) {
  const key = items.map((item) => item.id).join(" ");
  const ids = useMemo(() => (key === "" ? [] : key.split(" ")), [key]);
  const active = useActiveHeading(ids);
  if (items.length === 0) return null;
  if (variant === "fold") {
    return (
      <details className="toc-fold">
        <summary className="toc-fold-head">
          <span>On this page</span>
          <ChevronGlyph />
        </summary>
        <nav aria-label="On this page">
          <TocList items={items} active={active} />
        </nav>
      </details>
    );
  }
  return (
    <nav className="toc" aria-label="On this page">
      <p className="toc-label">On this page</p>
      <TocList items={items} active={active} follow />
    </nav>
  );
}
