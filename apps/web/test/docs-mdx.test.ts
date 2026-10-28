import { join } from "node:path";
import { compile, run } from "@mdx-js/mdx";
import GithubSlugger from "github-slugger";
import { createElement, type ReactNode } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { DocData } from "../src/lib/docs/content";
import { docsMdxOptions } from "../src/lib/docs/mdx/options";

/** The plugins exactly as next.config.ts hands them to the loader, imported the way @next/mdx imports them */
async function plugins(list: string[]) {
  return Promise.all(list.map(async (name) => ((await import(name)) as { default: unknown }).default));
}

async function compileDoc(source: string) {
  const options = docsMdxOptions(join(import.meta.dirname, "../src/lib/docs/mdx"));
  const code = await compile(source, {
    outputFormat: "function-body",
    remarkPlugins: (await plugins(options.remarkPlugins)) as never,
    rehypePlugins: (await plugins(options.rehypePlugins)) as never,
  });
  const mod = (await run(code, { ...runtime, baseUrl: import.meta.url })) as unknown as {
    default: (props: { components?: Record<string, unknown> }) => ReactNode;
    meta?: { title?: string; description?: string };
    docData: DocData;
  };
  return mod;
}

function html(mod: Awaited<ReturnType<typeof compileDoc>>, components: Record<string, unknown> = {}): string {
  const Pre = ({ title, children }: { title?: string; children?: ReactNode }) =>
    createElement("pre", { "data-title": title ?? "none" }, children);
  return renderToStaticMarkup(createElement(mod.default, { components: { pre: Pre, ...components } }));
}

const META = `export const meta = {
  title: "Prepaid vouchers",
  description: "One deposit, then a signed voucher per call.",
};
`;

describe("heading anchors", () => {
  test("follow github-slugger: lower case, spaces as hyphens, punctuation dropped", async () => {
    const mod = await compileDoc(`${META}
## The deposit, explained!

### Using \`paidFetch\` with @z402/client

## What's a UIVK? (and why)
`);
    expect(mod.docData.toc).toEqual([
      { depth: 2, id: "the-deposit-explained", text: "The deposit, explained!" },
      { depth: 3, id: "using-paidfetch-with-z402client", text: "Using paidFetch with @z402/client" },
      { depth: 2, id: "whats-a-uivk-and-why", text: "What's a UIVK? (and why)" },
    ]);
    const slugger = new GithubSlugger();
    for (const item of mod.docData.toc) expect(item.id).toBe(slugger.slug(item.text));
  });

  test("number a repeated heading, and the rendered ids match the TOC", async () => {
    const mod = await compileDoc(`${META}
## Errors

## Errors

### Errors
`);
    expect(mod.docData.toc.map((t) => t.id)).toEqual(["errors", "errors-1", "errors-2"]);
    const out = html(mod);
    for (const { id } of mod.docData.toc) expect(out).toContain(`id="${id}"`);
  });

  test("leave H4 out of the TOC but give it an id", async () => {
    const mod = await compileDoc(`${META}
## Section

#### A label
`);
    expect(mod.docData.toc.map((t) => t.id)).toEqual(["section"]);
    expect(html(mod)).toContain('<h4 id="a-label">');
  });
});

describe("code meta", () => {
  test("hands a fence's title to <pre> and keeps its language on <code>", async () => {
    const mod = await compileDoc(`${META}
\`\`\`ts title="agent.ts"
const x = 1;
\`\`\`
`);
    const out = html(mod);
    expect(out).toContain('<pre data-title="agent.ts"><code class="language-ts">const x = 1;\n</code></pre>');
  });

  test("keeps a title with spaces, commas and parentheses whole", async () => {
    const mod = await compileDoc(`${META}
\`\`\`json title="PAYMENT-REQUIRED, decoded (abridged)"
{}
\`\`\`
`);
    expect(html(mod)).toContain('data-title="PAYMENT-REQUIRED, decoded (abridged)"');
  });

  test("leaves a fence without meta alone, mermaid included", async () => {
    const mod = await compileDoc(`${META}
\`\`\`bash
docker compose up -d
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`);
    const out = html(mod);
    expect(out).toContain('<pre data-title="none"><code class="language-bash">');
    expect(out).toContain('<pre data-title="none"><code class="language-mermaid">flowchart LR');
  });

  test("passes a fence's title through the components' code tabs", async () => {
    const mod = await compileDoc(`${META}
<CodeTabs>

\`\`\`ts title="agent.ts"
a();
\`\`\`

\`\`\`ts title="zcash.ts"
b();
\`\`\`

</CodeTabs>
`);
    const titles: string[] = [];
    const CodeTabs = ({ children }: { children?: ReactNode }) => {
      for (const child of [children].flat()) {
        const props = (child as { props?: { title?: string } } | null)?.props;
        if (props?.title !== undefined) titles.push(props.title);
      }
      return null;
    };
    html(mod, { CodeTabs });
    expect(titles).toEqual(["agent.ts", "zcash.ts"]);
  });
});

describe("docData", () => {
  test("reads meta and gives the page's Markdown its title and description in place of the export", async () => {
    const mod = await compileDoc(`${META}
Intro with a <Term tip="A viewing key">UIVK</Term>.

## Next
`);
    expect(mod.meta).toEqual({ title: "Prepaid vouchers", description: "One deposit, then a signed voucher per call." });
    expect(mod.docData.markdown).toBe(
      '# Prepaid vouchers\n\nOne deposit, then a signed voucher per call.\n\nIntro with a <Term tip="A viewing key">UIVK</Term>.\n\n## Next\n',
    );
  });

  test("splits the text by heading for search, without diagrams, tooltips and code names kept apart", async () => {
    const mod = await compileDoc(`${META}
Intro with a <Term tip="A viewing key">UIVK</Term> and a [link](/docs/x).

## Deposit

One **shielded** deposit.

\`\`\`mermaid
flowchart LR
  Secret --> Diagram
\`\`\`

<Steps>
<Step title="Install">

Run \`pnpm add\`.

\`\`\`ts
const paidFetch = wrapFetchWithPayment(fetch, client);
paidFetch(url);
\`\`\`

</Step>
</Steps>
`);
    expect(mod.docData.sections).toEqual([
      { id: null, heading: null, text: "Intro with a UIVK and a link.", extra: "A viewing key" },
      {
        id: "deposit",
        heading: "Deposit",
        text: "One shielded deposit. Install Run pnpm add.",
        extra: "paidFetch wrapFetchWithPayment fetch client url",
      },
    ]);
  });

  test("warns about a missing description and a # heading, and still builds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await compileDoc(`export const meta = { title: "Only a title" };

# A second title
`);
    expect(mod.docData.markdown.startsWith("# Only a title\n\n# A second title")).toBe(true);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("has no meta.description"))).toBe(true);
    expect(messages.some((m) => m.includes('"#" heading'))).toBe(true);
    warn.mockRestore();
  });
});
