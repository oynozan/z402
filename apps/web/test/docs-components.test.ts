import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Source } from "../src/components/docs/blocks";
import { fenceOf } from "../src/components/docs/code";
import { Mermaid } from "../src/components/docs/mermaid";
import { codeLanguage } from "../src/lib/docs/highlight";
import { manropeMeasurer } from "../src/lib/docs/manrope";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fenceOf", () => {
  test("reads the code and the language from the <code> inside a <pre>, without the closing newline", () => {
    const code = createElement("code", { className: "language-ts" }, "const x = 1;\n");
    expect(fenceOf(code)).toEqual({ code: "const x = 1;", lang: "ts" });
    expect(fenceOf(createElement("code", null, "plain\n"))).toEqual({ code: "plain", lang: null });
    expect(fenceOf("not an element")).toBeNull();
  });
});

describe("codeLanguage", () => {
  test("maps a fence's language to a grammar and a label", () => {
    expect(codeLanguage("ts")).toEqual({ grammar: "typescript", label: "TypeScript" });
    expect(codeLanguage("bash")).toEqual({ grammar: "shellscript", label: "Bash" });
    expect(codeLanguage("sh")).toEqual({ grammar: "shellscript", label: "Shell" });
    expect(codeLanguage("YML")).toEqual({ grammar: "yaml", label: "YAML" });
    expect(codeLanguage("http")).toEqual({ grammar: "http", label: "HTTP" });
    expect(codeLanguage("text")).toEqual({ grammar: null, label: "Text" });
    expect(codeLanguage(null)).toEqual({ grammar: null, label: "Text" });
    expect(codeLanguage("brainfuck")).toEqual({ grammar: null, label: "brainfuck" });
  });
});

describe("Mermaid", () => {
  test("draws a diagram to inline SVG in the site's colors and font", () => {
    const out = renderToStaticMarkup(createElement(Mermaid, { source: "flowchart LR\n  A[Agent] --> B[Server]" }));
    expect(out).toContain('<figure class="diagram"');
    expect(out).toContain("<svg");
    expect(out).toContain("var(--pele-surface");
    expect(out).toContain(">Agent<");
  });

  test("draws a left-to-right flowchart too wide for the column top to bottom", () => {
    const wide = `flowchart LR
  A["1. The API answers 402 with its price"] --> B["2. The agent deposits once, shielded"]
  B --> C["3. Each call carries a signed voucher"]
  C --> D["4. The provider checks it and serves the call"]`;
    const out = renderToStaticMarkup(createElement(Mermaid, { source: wide }));
    const width = Number(/<svg[^>]* width="([\d.]+)"/.exec(out)?.[1]);
    expect(width).toBeLessThanOrEqual(670);
  });

  test("adds a narrower drawing, and the rule that swaps it in, for a diagram wider than a phone", () => {
    const sequence = `sequenceDiagram
  participant A as Agent
  participant S as Resource server
  participant F as Facilitator
  A->>S: GET /chunk
  S-->>A: 402 Payment Required (terms)
  S->>F: POST /verify`;
    const out = renderToStaticMarkup(createElement(Mermaid, { source: sequence }));
    expect(out).toContain('class="diagram-narrow"');
    expect(out).toMatch(/@container \(width &lt; \d+px\)|@container \(width < \d+px\)/);
  });

  test("draws a graph that cannot fold any narrower once", () => {
    // A dependency graph of one-word names, as wide on a phone as anywhere
    const fan = `flowchart TD
  Z[zebra] --> CI([chain-init])
  CI --> ZI([zallet-init])
  CI --> ZA[zaino]
  ZI --> ZL[zallet]
  ZL --> WF([wallet-fund])
  WF --> CK[clock]
  KG([keygen]) --> FA[facilitator]
  ZA --> FA
  KG --> MR([markdown-register])
  FA --> MR
  FA --> API[api]
  FA --> LLM[llm]
  FA --> EMB[embeddings]
  FA --> DB[dropbox]
  FA --> WEB[web]
  FA --> MD[markdown]
  MR --> MD
  LM[llm-model] --> LLM
  EM[embed-model] --> EMB`;
    const out = renderToStaticMarkup(createElement(Mermaid, { source: fan }));
    expect(out.match(/<svg/g)).toHaveLength(1);
    expect(out).not.toContain("@container");
  });

  test("shows a syntax error on the page outside a production build", () => {
    vi.stubEnv("NODE_ENV", "development");
    const out = renderToStaticMarkup(createElement(Mermaid, { source: "flowchart LR\n  A -->" }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Mermaid error");
    expect(out).toContain("Parse error on line 2");
  });

  test("throws on a syntax error in a production build, which fails it", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => renderToStaticMarkup(createElement(Mermaid, { source: "flowchart LR\n  A -->" }))).toThrow(
      /mermaid diagram does not render/,
    );
  });
});

describe("manropeMeasurer", () => {
  test("measures Manrope's advances, monospace at six tenths of an em", () => {
    expect(manropeMeasurer.width(" ", 1000, 0)).toBe(200);
    expect(manropeMeasurer.width("Agent", 14, 0)).toBeCloseTo((634 + 592 + 585 + 594 + 401) * 0.014, 5);
    expect(manropeMeasurer.width("Agent", 14, 1)).toBeGreaterThan(manropeMeasurer.width("Agent", 14, 0));
    expect(manropeMeasurer.width("abc", 10, 4)).toBe(18);
  });
});

describe("Source", () => {
  test("links the file on GitHub when the repository is set", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "https://github.com/example/z402/");
    const out = renderToStaticMarkup(createElement(Source, { path: "packages/client/src/scheme.ts", line: "12" }));
    expect(out).toContain('href="https://github.com/example/z402/blob/main/packages/client/src/scheme.ts#L12"');
    expect(out).toContain(">packages/client/src/scheme.ts</code>");
  });

  test("shows the path as code when it is not", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "");
    const out = renderToStaticMarkup(createElement(Source, { path: "./compose.yaml" }));
    expect(out).toBe('<code class="md-code source">compose.yaml</code>');
  });
});
