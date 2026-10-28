/**
 * Reads the whole Bazaar list, a page at a time. The facilitator serves at most 100 items a page and holds at most
 * 4096, so a read is never more than 41 requests. A page that cannot be read fails the whole read, so the site never
 * shows a service with some of its routes missing.
 */
import { countOf } from "./format";
import { record } from "./services";

export const LIST_PATH = "/discovery/resources";
/** The largest page the facilitator serves */
export const PAGE_LIMIT = 100;
/** The most items the facilitator holds */
export const MAX_ITEMS = 4096;
const MAX_PAGES = Math.ceil(MAX_ITEMS / PAGE_LIMIT);

export interface ListRead {
  items: unknown[];
  pages: number;
}

/** One page of the HTTP resources, the query the site, its poll and an agent reading through the proxy all send */
export function pageQuery(offset: number): string {
  return `?type=http&limit=${PAGE_LIMIT}&offset=${offset}`;
}

/** Every item, from offset 0 until the offset reaches the total by what each page held, or null at the first bad page */
export async function readList(read: (query: string) => Promise<unknown>): Promise<ListRead | null> {
  const items: unknown[] = [];
  for (let pages = 1; ; pages++) {
    const page = record(await read(pageQuery(items.length)));
    const got = page?.items;
    if (!Array.isArray(got)) return null;
    // Never more than the list can hold, since spreading a whole oversized page overflows the stack
    items.push(...got.slice(0, MAX_ITEMS - items.length));
    const total = countOf(record(page?.pagination)?.total);
    if (got.length === 0 || total === null || items.length >= Math.min(total, MAX_ITEMS) || pages === MAX_PAGES) {
      return { items, pages };
    }
  }
}
