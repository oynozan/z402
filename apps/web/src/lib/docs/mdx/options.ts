import { join } from "node:path";

export interface DocsMdxOptions {
  remarkPlugins: string[];
  rehypePlugins: string[];
}

/**
 * How the docs' MDX is compiled, shared by next.config.ts and the tests. Each plugin is a package name or an absolute
 * path, because Turbopack hands loader options to its Node workers as JSON. rehype-slug gives the headings their ids
 * (github-slugger), rehype-docs reads them back for the page's TOC, search text and Markdown, and
 * rehype-mdx-code-props turns a fence's meta, such as title="agent.ts", into props on <pre>, so it runs last.
 */
export function docsMdxOptions(pluginDir: string): DocsMdxOptions {
  return {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: ["rehype-slug", join(pluginDir, "rehype-docs.mjs"), "rehype-mdx-code-props"],
  };
}
