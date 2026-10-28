"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DiscoverySnapshot, Offer, ServiceStatus } from "@/lib/discovery-types";
import { RESOURCES_QUERY } from "@/lib/proxy";
import { buildBoard, parseResources, parseStatus, type Board } from "@/lib/services";

const STATUS_EVERY_MS = 5_000;
const RESOURCES_EVERY_MS = 30_000;
/** A single missed poll keeps the last status, a second one clears it */
const STATUS_MISSES_ALLOWED = 1;

const BoardContext = createContext<Board | null>(null);

async function poll(path: string): Promise<unknown> {
  try {
    const res = await fetch(path, { cache: "no-store", headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export function DiscoveryProvider({ initial, children }: { initial: DiscoverySnapshot; children: ReactNode }) {
  const [offers, setOffers] = useState<Offer[] | null>(initial.offers);
  const [status, setStatus] = useState<ServiceStatus[] | null>(initial.status);

  useEffect(() => {
    let alive = true;
    let misses = 0;
    let haveOffers = initial.offers !== null;
    const timers: number[] = [];

    const readResources = async () => {
      const next = parseResources(await poll(`/discovery/resources${RESOURCES_QUERY}`));
      if (!alive || next === null) return;
      haveOffers = true;
      setOffers(next);
    };
    const readStatus = async () => {
      const next = parseStatus(await poll("/discovery/status"));
      if (!alive) return;
      if (next !== null) {
        misses = 0;
        setStatus(next);
        // Discovery is back after a failed first read, so the routes need not wait for their own poll
        if (!haveOffers) void readResources();
      } else if (++misses > STATUS_MISSES_ALLOWED) {
        setStatus(null);
      }
    };

    const start = () => {
      timers.push(window.setInterval(readStatus, STATUS_EVERY_MS), window.setInterval(readResources, RESOURCES_EVERY_MS));
    };
    const stop = () => timers.splice(0).forEach((t) => window.clearInterval(t));
    const onVisibility = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      void readStatus();
      void readResources();
      start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const board = useMemo(() => buildBoard({ offers, status }), [offers, status]);
  return <BoardContext value={board}>{children}</BoardContext>;
}

export function useBoard(): Board {
  const board = useContext(BoardContext);
  if (board === null) throw new Error("useBoard needs a DiscoveryProvider above it");
  return board;
}
