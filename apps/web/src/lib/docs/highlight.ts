import { createHighlighter, type Highlighter, type ThemeRegistrationRaw, type ThemedToken } from "shiki";

/**
 * Syntax highlighting with shiki on the server, so a page ships colored spans and no highlighter. The theme's colors
 * are CSS variables that docs.css maps to the site's tokens: orange keywords, green strings, lavender functions and
 * keys, subtle comments, as on the landing page's code.
 */

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "shellscript",
  "http",
  "yaml",
  "dockerfile",
  "diff",
  "dotenv",
  "toml",
  "ini",
  "html",
  "css",
  "markdown",
  "sql",
] as const;

type Lang = (typeof LANGS)[number];

/** The fence's language as a writer types it, mapped to the grammar that colors it */
const ALIASES: Record<string, Lang> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  http: "http",
  yaml: "yaml",
  yml: "yaml",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  diff: "diff",
  env: "dotenv",
  dotenv: "dotenv",
  toml: "toml",
  ini: "ini",
  html: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
};

/** The label of a block without a title, named as the writer named its language */
const LABELS: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON5",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  shellscript: "Shell",
  zsh: "Zsh",
  console: "Console",
  http: "HTTP",
  yaml: "YAML",
  yml: "YAML",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  diff: "Diff",
  env: "Env",
  dotenv: "Env",
  toml: "TOML",
  ini: "INI",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
  markdown: "Markdown",
  sql: "SQL",
};

const PLAIN = new Set(["", "text", "txt", "plain", "plaintext", "output", "log"]);

const color = (name: string) => `var(--code-${name})`;

const THEME: ThemeRegistrationRaw = {
  name: "z402",
  type: "dark",
  colors: { "editor.foreground": color("fg"), "editor.background": color("bg") },
  // The rules go in settings: shiki reads tokenColors only when settings is absent
  settings: [
    { settings: { foreground: color("fg") } },
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: color("comment") } },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.word",
        "variable.language",
        "entity.name.tag",
        "punctuation.definition.template-expression",
        "punctuation.section.embedded",
        "support.function.builtin.shell",
        "entity.name.command",
        "keyword.other.special-method.dockerfile",
        "keyword.http",
      ],
      settings: { foreground: color("keyword") },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation",
        "meta.brace",
        "meta.delimiter",
        "string.unquoted.argument.shell",
        "constant.other.option",
      ],
      settings: { foreground: color("fg") },
    },
    {
      scope: ["string", "string.quoted", "string.template", "punctuation.definition.string", "string.unquoted.plain.out.yaml"],
      settings: { foreground: color("string") },
    },
    { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: color("constant") } },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
        "entity.name.type",
        "entity.name.class",
        "support.class",
        "support.type",
        "entity.other.inherited-class",
        "entity.other.attribute-name",
        "variable.other.normal.shell",
        "variable.other.positional.shell",
        "variable.other.special.shell",
        "punctuation.definition.variable.shell",
        "variable.other.bracket.shell",
      ],
      settings: { foreground: color("function") },
    },
    {
      scope: [
        "support.type.property-name",
        "punctuation.support.type.property-name",
        "entity.name.tag.yaml",
        "variable.other.env",
        "variable.other.key.toml",
        "keyword.other.definition.ini",
        "entity.name.type.http",
        "meta.header.http entity.name",
      ],
      settings: { foreground: color("key") },
    },
    {
      scope: ["constant.numeric", "constant.language", "support.constant", "constant.other.placeholder"],
      settings: { foreground: color("constant") },
    },
    { scope: ["markup.inserted", "punctuation.definition.inserted"], settings: { foreground: color("inserted") } },
    { scope: ["markup.deleted", "punctuation.definition.deleted"], settings: { foreground: color("deleted") } },
    { scope: ["meta.diff.range", "meta.diff.header"], settings: { foreground: color("comment") } },
  ],
};

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: [THEME], langs: [...LANGS] });
  return highlighter;
}

export interface CodeLanguage {
  /** The grammar, or null for plain text */
  grammar: Lang | null;
  /** The label for a block without a title */
  label: string;
}

export function codeLanguage(lang: string | null | undefined): CodeLanguage {
  const key = (lang ?? "").trim().toLowerCase();
  const grammar = ALIASES[key] ?? null;
  if (grammar !== null) return { grammar, label: LABELS[key] ?? key };
  return { grammar: null, label: PLAIN.has(key) ? "Text" : key };
}

export type CodeToken = Pick<ThemedToken, "content" | "color">;

/** The code's lines as colored tokens; plain text and unknown languages come back as one uncolored token a line */
export async function highlight(code: string, lang: string | null | undefined): Promise<CodeToken[][]> {
  const { grammar } = codeLanguage(lang);
  if (grammar === null) {
    const key = (lang ?? "").trim().toLowerCase();
    if (!PLAIN.has(key) && process.env.NODE_ENV !== "production") {
      console.warn(`[docs] no highlighting for the code language "${key}"; it shows as plain text`);
    }
    return code.split("\n").map((line) => [{ content: line, color: undefined }]);
  }
  const shiki = await getHighlighter();
  return shiki.codeToTokens(code, { lang: grammar, theme: "z402" }).tokens;
}
