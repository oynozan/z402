import { connection } from "next/server";
import type { DiscoverySnapshot } from "./discovery-types";
import { DISCOVERY_TIMEOUT_MS, RESOURCES_QUERY, discoveryBase } from "./proxy";
import { parseResources, parseStatus } from "./services";

async function readJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Reads discovery at request time, so a build never needs it and a page never shows a stale list */
export async function loadDiscovery(): Promise<DiscoverySnapshot> {
  await connection();
  const base = discoveryBase(process.env.DISCOVERY_URL);
  const [resources, status] = await Promise.all([
    readJson(`${base}/discovery/resources${RESOURCES_QUERY}`),
    readJson(`${base}/discovery/status`),
  ]);
  return { offers: parseResources(resources), status: parseStatus(status) };
}
