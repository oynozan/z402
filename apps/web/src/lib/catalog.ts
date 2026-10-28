import { DASH, formatPriceRange } from "./format";
import { OTHER, type ServiceRow } from "./services";

export interface Category {
  key: string;
  count: number;
}

/** One filter per category, the largest first, ties in the order discovery lists them, and OTHER always last */
export function categories(services: readonly ServiceRow[]): Category[] {
  const counts = new Map<string, number>();
  for (const service of services) counts.set(service.category, (counts.get(service.category) ?? 0) + 1);
  const order = [...counts.keys()];
  return order
    .map((key) => ({ key, count: counts.get(key) ?? 0 }))
    .sort((a, b) => {
      if ((a.key === OTHER) !== (b.key === OTHER)) return a.key === OTHER ? 1 : -1;
      return b.count - a.count || order.indexOf(a.key) - order.indexOf(b.key);
    });
}

/** The last path segment that is neither a version nor a parameter, e.g. generate in /v1/generate */
function resourceName(path: string): string | null {
  const segments = path
    .split("?")[0]!
    .split("/")
    .filter((s) => s !== "" && !/^v\d+$/i.test(s) && !s.startsWith(":") && !/^\[.*\]$/.test(s));
  return segments.at(-1)?.toLowerCase() ?? null;
}

/** A short handle such as llm/generate, the category and what the first route is called */
export function slugOf(service: ServiceRow): string {
  const first = service.routes[0];
  const name = first === undefined ? null : resourceName(first.path);
  if (name === null) return service.category === OTHER ? service.name.toLowerCase().replace(/\s+/g, "-") : service.category;
  return name === service.category ? name : `${service.category}/${name}`;
}

/** Everything a search may match, lower case */
export function searchText(service: ServiceRow): string {
  const parts = [service.name, service.category, ...service.tags, service.unit ?? ""];
  for (const route of service.routes) parts.push(route.path, route.description ?? "", route.unit ?? "");
  return parts.join(" ").toLowerCase();
}

/** Every word of the query has to appear somewhere in the service */
export function matchesQuery(service: ServiceRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const text = searchText(service);
  return words.every((word) => text.includes(word));
}

export function filterServices(
  services: readonly ServiceRow[],
  { category, query }: { category: string | null; query: string },
): ServiceRow[] {
  return services.filter((s) => (category === null || s.category === category) && matchesQuery(s, query));
}

export interface Totals {
  services: number;
  /** Null while the health of every service is unknown */
  up: number | null;
  /** Null until at least one service reports a count */
  callsToday: number | null;
}

export function totals(services: readonly ServiceRow[]): Totals {
  let calls: number | null = null;
  for (const service of services) {
    if (service.callsToday !== null) calls = (calls ?? 0) + service.callsToday;
  }
  const known = services.some((s) => s.health !== "unknown");
  return {
    services: services.length,
    up: known ? services.filter((s) => s.health === "up").length : null,
    callsToday: calls,
  };
}

/** One price, or the range when the routes of a service charge differently */
export function priceText(service: ServiceRow): string {
  return service.routes.length > 0 ? formatPriceRange(service.routes.map((r) => r.priceZat)) : formatPriceRange([service.priceZat]);
}

/** What one call buys, or each of the different units the routes sell */
export function unitText(service: ServiceRow): string {
  const units = [...new Set(service.routes.map((r) => r.unit).filter((u): u is string => u !== null))];
  if (units.length === 0) return service.unit ?? DASH;
  return units.join(", ");
}
