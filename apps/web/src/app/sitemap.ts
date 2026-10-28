import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { availableFiles } from "@/lib/docs/content";
import { DOC_PAGES } from "@/lib/docs/ia";
import { siteOrigin } from "@/lib/origin";

/** The site's pages and every docs page in the sidebar, at the origin the request came to; hidden pages stay out */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [requestHeaders, available] = await Promise.all([headers(), availableFiles()]);
  const origin = siteOrigin((name) => requestHeaders.get(name));
  const docs = DOC_PAGES.filter((page) => available.has(page.file)).map((page) => page.href);
  return ["/", "/services", ...docs].map((path) => ({ url: `${origin}${path}` }));
}
