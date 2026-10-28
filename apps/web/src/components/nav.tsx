"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  external?: boolean;
}

function useCurrent(href: string): "page" | undefined {
  return usePathname() === href ? "page" : undefined;
}

export function NavLink({ item, className, onClick }: { item: NavItem; className: string; onClick?: () => void }) {
  const current = useCurrent(item.href);
  if (item.external === true) {
    return (
      <a className={className} href={item.href} target="_blank" rel="noreferrer" onClick={onClick}>
        {item.label}
      </a>
    );
  }
  return (
    <Link className={className} href={item.href} aria-current={current} onClick={onClick}>
      {item.label}
    </Link>
  );
}

const MENU_ID = "nav-menu";
const DESKTOP = "(min-width: 1025px)";

/** The menu cell that stands in for the link cells on a narrow screen, with its links as rows under the bar */
export function MenuToggle({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) setOpen(false);
    };
    const wide = window.matchMedia(DESKTOP);
    const onWide = () => wide.matches && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  return (
    <div className="nav-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls={MENU_ID}
        aria-label={open ? "Close menu" : "Open menu"}
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true" />
      </button>
      <nav id={MENU_ID} className="nav-drop" aria-label="Menu" hidden={!open}>
        {items.map((item) => (
          <NavLink key={item.href} item={item} className="nav-drop-link" onClick={() => setOpen(false)} />
        ))}
      </nav>
    </div>
  );
}
