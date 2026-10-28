"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LIST_PATH, readList } from "@/lib/bazaar";
import type { DiscoverySnapshot } from "@/lib/discovery-types";
import { buildBoard, parseResources, type Board } from "@/lib/services";

/** Per page of the list, so the site asks for one page every 5 s at most however long the list grows */
const EVERY_MS = 5_000;
/** A single failed read keeps the last statuses, a second one clears them */
const MISSES_ALLOWED = 1;

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
      const res = await fetch(`${LIST_PATH}${query}`, { cache: "no-store", headers: { accept: "application/json" } });
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
    let reading = false;
    let timer: number | undefined;

    const read = async () => {
      if (reading) return;
      reading = true;
      const next = await readBazaar();
      reading = false;
      if (!alive) return;
      if (next !== null) {
        misses = 0;
        setSnapshot(next.snapshot);
      } else if (++misses > MISSES_ALLOWED) {
        // The list stays, without the statuses and counts that only a fresh read vouches for
        setSnapshot((s) => (s.at === null ? s : { ...s, at: null }));
      }
      schedule(next?.pages ?? 1);
    };
    const schedule = (pages: number) => {
      window.clearTimeout(timer);
      if (alive && document.visibilityState === "visible") timer = window.setTimeout(read, EVERY_MS * pages);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void read();
    };

    schedule(1);
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
