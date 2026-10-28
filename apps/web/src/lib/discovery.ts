import { connection } from "next/server";
import { LIST_PATH, readList } from "./bazaar";
import type { DiscoverySnapshot } from "./discovery-types";
import { DISCOVERY_TIMEOUT_MS, discoveryBase } from "./proxy";
import { parseResources } from "./services";

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" }, signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Reads the Bazaar at request time, so a build never needs it and a page never shows a stale list */
export async function loadDiscovery(): Promise<DiscoverySnapshot> {
  await connection();
  const base = discoveryBase(process.env.DISCOVERY_URL);
  // One deadline for every page, so a long list holds the page up no longer than one slow read would
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const list = await readList((query) => readJson(`${base}${LIST_PATH}${query}`, signal));
  const offers = list === null ? null : parseResources(list.items);
  return { offers, at: offers === null ? null : Date.now() };
}
