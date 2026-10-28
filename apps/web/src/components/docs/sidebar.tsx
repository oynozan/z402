"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronGlyph, CloseGlyph, SearchGlyph } from "./glyphs";
import { prefetchSearchIndex, useOpenSearch } from "./search";

export interface SideSection {
  label: string;
  pages: { href: string; title: string }[];
}

function subscribeNever(): () => void {
  return () => {};
}

/** ⌘K on a Mac, Ctrl K elsewhere; the server, which cannot tell, draws the Mac's */
function useShortcutLabel(): string {
  return useSyncExternalStore(
    subscribeNever,
    () => (/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => "⌘K",
  );
}

function NavList({ nav, onPick }: { nav: SideSection[]; onPick?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {nav.map((section) => (
        <div key={section.label} className="side-group">
          <p className="side-label">{section.label}</p>
          <ul className="side-list">
            {section.pages.map((page) => (
              <li key={page.href}>
                <Link
                  className="side-link"
                  href={page.href}
                  aria-current={pathname === page.href ? "page" : undefined}
                  onClick={onPick}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The left column: the search box, then each section's pages, the current one filled like an active filter */
export function DocsSidebar({ nav }: { nav: SideSection[] }) {
  const openSearch = useOpenSearch();
  const shortcut = useShortcutLabel();
  const listRef = useRef<HTMLElement>(null);
  const pathname = usePathname();

  // Keep the current page in view when the list is taller than the window, scrolling the list and never the page
  useEffect(() => {
    const nav = listRef.current;
    const box = nav?.parentElement;
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (box == null || link == null || box.scrollHeight <= box.clientHeight) return;
    const view = box.getBoundingClientRect();
    const at = link.getBoundingClientRect();
    if (at.top >= view.top && at.bottom <= view.bottom) return;
    box.scrollTop += at.top - view.top - (view.height - at.height) / 2;
  }, [pathname]);

  return (
    <nav className="side" aria-label="Docs" ref={listRef}>
      <button
        type="button"
        className="search side-search"
        onClick={openSearch}
        onPointerEnter={prefetchSearchIndex}
        onFocus={prefetchSearchIndex}
      >
        <SearchGlyph />
        <span className="side-search-text">Search docs</span>
        <kbd className="side-kbd">{shortcut}</kbd>
      </button>
      <NavList nav={nav} />
    </nav>
  );
}

const DESKTOP = "(min-width: 1025px)";

/** Below the desktop layout: a bar with the section and the page, a search button and a menu with the sidebar's list */
export function DocsMobileBar({ nav }: { nav: SideSection[] }) {
  const [open, setOpen] = useState(false);
  const openSearch = useOpenSearch();
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const section = nav.find((s) => s.pages.some((p) => p.href === pathname));
  const page = section?.pages.find((p) => p.href === pathname);

  useEffect(() => setOpen(false), [pathname]);

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
    <div className="docs-mobile" ref={rootRef}>
      <div className="docs-mobile-bar">
        <button
          ref={buttonRef}
          type="button"
          className="docs-mobile-menu"
          aria-expanded={open}
          aria-controls="docs-mobile-nav"
          data-open={open || undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="docs-mobile-where">
            <span className="docs-mobile-section">{section?.label ?? "Docs"}</span>
            {page !== undefined && page.title !== section?.label && <span className="docs-mobile-page">{page.title}</span>}
          </span>
          {open ? <CloseGlyph /> : <ChevronGlyph />}
          <span className="sr-only">{open ? "Close the docs menu" : "Open the docs menu"}</span>
        </button>
        <button
          type="button"
          className="docs-mobile-search"
          onClick={openSearch}
          onPointerDown={prefetchSearchIndex}
          onFocus={prefetchSearchIndex}
          aria-label="Search the docs"
        >
          <SearchGlyph />
        </button>
      </div>
      <nav id="docs-mobile-nav" className="docs-mobile-nav" aria-label="Docs" hidden={!open}>
        <NavList nav={nav} onPick={() => setOpen(false)} />
      </nav>
    </div>
  );
}
