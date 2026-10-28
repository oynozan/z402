import { availableFiles, loadDoc } from "@/lib/docs/content";
import { DOC_PAGES } from "@/lib/docs/ia";
import { buildSearchIndex, type SearchSource } from "@/lib/docs/search";

/** The search index, built once with the pages: every sidebar page's headings and text, in the sidebar's order */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const available = await availableFiles();
  const docs = await Promise.all(DOC_PAGES.filter((page) => available.has(page.file)).map((page) => loadDoc(page)));
  const sources: SearchSource[] = docs.flatMap((doc) =>
    doc === null
      ? []
      : [{ href: doc.page.href, title: doc.page.title, section: doc.page.section ?? "", sections: doc.data.sections }],
  );
  return Response.json(buildSearchIndex(sources));
}
