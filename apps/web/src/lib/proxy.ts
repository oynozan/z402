export const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:4030";
export const DISCOVERY_TIMEOUT_MS = 5_000;
export const DISCOVERY_PATHS = ["resources", "status"] as const;
export type DiscoveryPath = (typeof DISCOVERY_PATHS)[number];

/** Every item, so the site and an agent reading through it see the same list */
export const RESOURCES_QUERY = "?type=http&limit=1000";

export function discoveryBase(value: string | undefined): string {
  const text = value?.trim() ?? "";
  return (text === "" ? DEFAULT_DISCOVERY_URL : text).replace(/\/+$/, "");
}

export function allowedPath(segments: readonly string[] | undefined): DiscoveryPath | null {
  if (segments === undefined || segments.length !== 1) return null;
  const [segment] = segments;
  return (DISCOVERY_PATHS as readonly string[]).includes(segment ?? "") ? (segment as DiscoveryPath) : null;
}

/** The discovery URL a proxied request goes to, or null for a path the site does not pass on */
export function upstreamUrl(base: string, segments: readonly string[] | undefined, search: string): string | null {
  const path = allowedPath(segments);
  if (path === null) return null;
  const query = search.startsWith("?") && search.length > 1 ? search : "";
  return `${base}/discovery/${path}${query}`;
}
