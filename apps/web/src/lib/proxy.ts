/** The facilitator, which hosts the Bazaar */
export const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:4022";
export const DISCOVERY_TIMEOUT_MS = 5_000;

/** The Bazaar's two public reads, each with the query parameters the stock client sends it */
const READS = {
  resources: ["type", "payTo", "scheme", "network", "extensions", "limit", "offset"],
  search: ["query", "type", "payTo", "scheme", "network", "extensions", "limit", "cursor"],
} as const satisfies Record<string, readonly string[]>;
export type DiscoveryPath = keyof typeof READS;

export function discoveryBase(value: string | undefined): string {
  const text = value?.trim() ?? "";
  return (text === "" ? DEFAULT_DISCOVERY_URL : text).replace(/\/+$/, "");
}

export function allowedPath(segments: readonly string[] | undefined): DiscoveryPath | null {
  if (segments === undefined || segments.length !== 1) return null;
  const [segment] = segments;
  return segment !== undefined && Object.hasOwn(READS, segment) ? (segment as DiscoveryPath) : null;
}

/** The parameters the read documents, in the order and as often as they came, and nothing else */
export function forwardedQuery(path: DiscoveryPath, search: string): string {
  const names: readonly string[] = READS[path];
  const kept = new URLSearchParams();
  for (const [name, value] of new URLSearchParams(search)) if (names.includes(name)) kept.append(name, value);
  const query = kept.toString();
  return query === "" ? "" : `?${query}`;
}

/** The Bazaar URL a proxied request goes to, or null for a path the site does not pass on */
export function upstreamUrl(base: string, segments: readonly string[] | undefined, search: string): string | null {
  const path = allowedPath(segments);
  return path === null ? null : `${base}/discovery/${path}${forwardedQuery(path, search)}`;
}
