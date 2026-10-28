"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { searchDocs, type SearchHit, type SearchIndex } from "@/lib/docs/search";
import { SearchGlyph } from "./glyphs";

export const SEARCH_INDEX_URL = "/docs/search.json";

export interface SearchSuggestion {
  href: string;
  title: string;
  section: string;
}

const SearchContext = createContext<() => void>(() => {});

/** Opens the docs search, from the sidebar's box or the phone bar's button */
export function useOpenSearch(): () => void {
  return useContext(SearchContext);
}

let indexRequest: Promise<SearchIndex> | null = null;

/** Starts loading the index before the dialog opens, when a pointer or focus reaches a search control */
export function prefetchSearchIndex(): void {
  void loadIndex().catch(() => {});
}

function loadIndex(): Promise<SearchIndex> {
  indexRequest ??= fetch(SEARCH_INDEX_URL).then((res) => {
    if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
    return res.json() as Promise<SearchIndex>;
  });
  indexRequest.catch(() => {
    indexRequest = null;
  });
  return indexRequest;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** Cmd+K or Ctrl+K anywhere under /docs, and "/" outside a text field, open the search dialog */
export function DocsSearch({ suggestions, children }: { suggestions: SearchSuggestion[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !isTyping(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SearchContext.Provider value={openSearch}>
      {children}
      {open && <SearchDialog suggestions={suggestions} onClose={() => setOpen(false)} />}
    </SearchContext.Provider>
  );
}

type IndexState = { state: "loading" } | { state: "ready"; index: SearchIndex } | { state: "failed" };

interface Row {
  href: string;
  page: string;
  section: string;
  heading: string | null;
  snippet: SearchHit["snippet"];
}

function SearchDialog({ suggestions, onClose }: { suggestions: SearchSuggestion[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [index, setIndex] = useState<IndexState>({ state: "loading" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    loadIndex().then(
      (loaded) => live && setIndex({ state: "ready", index: loaded }),
      () => live && setIndex({ state: "failed" }),
    );
    return () => {
      live = false;
    };
  }, []);

  const trimmed = query.trim();
  const rows: Row[] = useMemo(() => {
    if (trimmed === "") {
      return suggestions.map((s) => ({ href: s.href, page: s.title, section: s.section, heading: null, snippet: [] }));
    }
    return index.state === "ready" ? searchDocs(index.index, trimmed) : [];
  }, [trimmed, index, suggestions]);

  useEffect(() => setActive(0), [trimmed]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      const row = rows[active];
      if (row === undefined) return;
      e.preventDefault();
      go(row.href);
    }
  };

  const status =
    trimmed === ""
      ? null
      : index.state === "loading"
        ? "Loading the index…"
        : index.state === "failed"
          ? "Search is not available right now."
          : rows.length === 0
            ? `No results for “${trimmed}”.`
            : null;

  return (
    <dialog
      ref={dialogRef}
      className="search-dialog"
      aria-label="Search the docs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-panel">
        <div className="search search-field">
          <SearchGlyph />
          <input
            className="search-input"
            type="text"
            inputMode="search"
            enterKeyHint="search"
            role="combobox"
            aria-label="Search the docs"
            aria-expanded={rows.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={rows.length > 0 ? `${id}-row-${active}` : undefined}
            aria-autocomplete="list"
            placeholder="Search the docs"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="search-esc" onClick={onClose} aria-label="Close search">
            Esc
          </button>
        </div>
        {trimmed === "" && rows.length > 0 && <p className="search-hint">Start here</p>}
        {status !== null ? (
          <p className="search-status" role="status">
            {status}
          </p>
        ) : (
          <ul className="search-results" id={`${id}-list`} role="listbox" aria-label="Results" ref={listRef}>
            {rows.map((row, i) => (
              <li key={`${row.href}-${i}`} role="presentation">
                <Link
                  id={`${id}-row-${i}`}
                  data-row={i}
                  role="option"
                  aria-selected={i === active}
                  className="search-row"
                  href={row.href}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={onClose}
                >
                  <span className="search-row-path">
                    {row.section}
                    {row.section !== "" && <span aria-hidden="true"> / </span>}
                    {row.page}
                  </span>
                  <span className="search-row-title">{row.heading ?? row.page}</span>
                  {row.snippet.length > 0 && (
                    <span className="search-row-text">
                      {row.snippet.map((part, j) => (part.mark ? <mark key={j}>{part.text}</mark> : part.text))}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="search-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </dialog>
  );
}
