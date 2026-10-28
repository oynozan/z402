import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy";
import { Crumbs, Pager } from "@/components/docs/page-parts";
import { DocsToc } from "@/components/docs/toc";
import { availableFiles, loadDoc, warnMissing } from "@/lib/docs/content";
import { DOC_PAGES, HIDDEN_PAGES, docCrumbs, docNeighbours, findDocPage } from "@/lib/docs/ia";

/** Every page is built ahead of time, and any other path under /docs is a 404 */
export const dynamic = "force-static";
export const dynamicParams = false;

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export async function generateStaticParams(): Promise<{ slug: string[] }[]> {
  const available = await availableFiles();
  warnMissing(available);
  return [...DOC_PAGES, ...HIDDEN_PAGES]
    .filter((page) => available.has(page.file))
    .map((page) => ({ slug: page.slug === "" ? [] : page.slug.split("/") }));
}

async function resolve(params: Props["params"]) {
  const { slug } = await params;
  const page = findDocPage(slug);
  return page === null ? null : loadDoc(page);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = await resolve(params);
  if (doc === null) return {};
  return {
    title: doc.page.slug === "" ? { absolute: "Docs · z402" } : doc.meta.title,
    description: doc.meta.description ?? undefined,
    robots: doc.page.hidden ? { index: false, follow: false } : undefined,
  };
}

export default async function DocPage({ params }: Props) {
  const doc = await resolve(params);
  if (doc === null) notFound();
  const available = await availableFiles();
  const { page, Content, meta, data } = doc;
  const { prev, next } = docNeighbours(page, available);

  return (
    <>
      <div className="doc-main">
        <article className="doc">
          <header className="doc-head">
            <div className="doc-bar">
              <Crumbs crumbs={docCrumbs(page, available)} />
              {data.markdown !== "" && (
                <CopyButton text={data.markdown} label="this page as Markdown" className="doc-copy">
                  Copy page
                </CopyButton>
              )}
            </div>
            <h1 className="doc-title">{meta.title}</h1>
            {meta.description !== null && <p className="doc-lede">{meta.description}</p>}
          </header>
          <DocsToc items={data.toc} variant="fold" />
          <div className="prose">
            <Content />
          </div>
          <Pager prev={prev} next={next} />
        </article>
      </div>
      <aside className="doc-rail">
        <div className="doc-rail-inner">
          <DocsToc items={data.toc} variant="rail" />
        </div>
      </aside>
    </>
  );
}
