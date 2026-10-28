"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LIST_PATH, readList } from "@/lib/bazaar";
import type { DiscoverySnapshot } from "@/lib/discovery-types";
import { DISCOVERY_TIMEOUT_MS } from "@/lib/proxy";
import { buildBoard, parseResources, type Board } from "@/lib/services";

/** Per page of the list, so the site asks for one page every 5 s at most however long the list grows */
const EVERY_MS = 5_000;
/** A single failed read keeps the last statuses, a second one clears them */
const MISSES_ALLOWED = 1;
/** Past the proxy's own deadline, so only a page that never comes back is cut, and it fails the read */
const PAGE_TIMEOUT_MS = 2 * DISCOVERY_TIMEOUT_MS;

const BoardContext = createContext<Board | null>(null);

interface Read {
  snapshot: DiscoverySnapshot;
  pages: number;
}

/** The whole list through the site's own proxy, timed by the server's Date header so a visitor's clock moves no status */
async function readBazaar(): Promise<Read | null> {
  let at = Number.NaN;
  const list = await readList(async (query) => {
    try {
      const res = await fetch(`${LIST_PATH}${query}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      at = Date.parse(res.headers.get("date") ?? "");
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  });
  const offers = list === null ? null : parseResources(list.items);
  if (list === null || offers === null) return null;
  return { snapshot: { offers, at: Number.isFinite(at) ? at : Date.now() }, pages: list.pages };
}

export function DiscoveryProvider({ initial, children }: { initial: DiscoverySnapshot; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DiscoverySnapshot>(initial);

  useEffect(() => {
    let alive = true;
    let misses = 0;
    // The pages of the last good read, which a failed read waits out too
    let pages = 1;
    let reading = false;
    let timer: number | undefined;

    const read = async () => {
      if (reading) return;
      reading = true;
      const next = await readBazaar().catch(() => null);
      reading = false;
      if (!alive) return;
      if (next !== null) {
        misses = 0;
        pages = next.pages;
        setSnapshot(next.snapshot);
      } else if (++misses > MISSES_ALLOWED) {
        // The list stays, without the statuses and counts that only a fresh read vouches for
        setSnapshot((s) => (s.at === null ? s : { ...s, at: null }));
      }
      schedule();
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (alive && document.visibilityState === "visible") timer = window.setTimeout(read, EVERY_MS * pages);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void read();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const board = useMemo(() => buildBoard(snapshot), [snapshot]);
  return <BoardContext value={board}>{children}</BoardContext>;
}

export function useBoard(): Board {
  const board = useContext(BoardContext);
  if (board === null) throw new Error("useBoard needs a DiscoveryProvider above it");
  return board;
}
