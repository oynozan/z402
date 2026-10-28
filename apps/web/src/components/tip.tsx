"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Opener = "hover" | "focus" | "tap";

const GAP = 8;
const EDGE = 12;
const CLOSE_DELAY_MS = 120;

function isMouse(e: React.PointerEvent): boolean {
  return e.pointerType === "mouse";
}

/** A "?" cell whose note opens on hover, keyboard focus or a tap, and closes on Escape or a tap elsewhere */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [opener, setOpener] = useState<Opener | null>(null);
  const open = opener !== null;

  const show = (by: Opener) => {
    window.clearTimeout(closeTimer.current);
    setOpener((current) => (current === "tap" ? current : by));
  };
  const close = () => {
    window.clearTimeout(closeTimer.current);
    setOpener(null);
  };
  const closeSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpener((current) => (current === "hover" ? null : current)), CLOSE_DELAY_MS);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    const pop = popRef.current;
    const button = buttonRef.current;
    if (!open || pop === null || button === null) return;
    const native = typeof pop.showPopover === "function";
    if (native) pop.showPopover();
    else pop.dataset.open = "";

    const place = () => {
      const anchor = button.getBoundingClientRect();
      const box = pop.getBoundingClientRect();
      const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - box.width / 2), window.innerWidth - EDGE - box.width);
      const above = anchor.top - GAP - box.height >= EDGE;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(above ? anchor.top - GAP - box.height : anchor.bottom + GAP)}px`;
    };
    place();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target !== null && (button.contains(target) || pop.contains(target))) return;
      close();
    };
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place, { passive: true });
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      if (native) {
        if (pop.matches(":popover-open")) pop.hidePopover();
      } else {
        delete pop.dataset.open;
      }
    };
  }, [open]);

  return (
    <span className="tip">
      <button
        ref={buttonRef}
        type="button"
        className="tip-q"
        aria-label={label}
        aria-describedby={id}
        data-open={open || undefined}
        onPointerEnter={(e) => isMouse(e) && show("hover")}
        onPointerLeave={(e) => isMouse(e) && closeSoon()}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show("focus")}
        onBlur={() => setOpener((current) => (current === "hover" ? current : null))}
        onClick={(e) => {
          // A tip inside a row that opens on click must not open the row as well
          e.stopPropagation();
          if (opener === "tap") close();
          else setOpener("tap");
        }}
      >
        ?
      </button>
      <span
        ref={popRef}
        id={id}
        role="tooltip"
        popover="manual"
        className="tip-pop"
        onPointerEnter={(e) => isMouse(e) && window.clearTimeout(closeTimer.current)}
        onPointerLeave={(e) => isMouse(e) && closeSoon()}
      >
        {children}
      </span>
    </span>
  );
}
