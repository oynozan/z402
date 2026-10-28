/**
 * A rehype plugin for the docs pages, run after rehype-slug. It exports `docData` from each MDX module:
 *
 * - `toc`: the H2 and H3 headings with the ids rehype-slug gave them, for "On this page";
 * - `sections`: the text under each heading, for the search index;
 * - `markdown`: the page's own source with its meta export swapped for its title and description, for "Copy page".
 *
 * It reads `export const meta = { title, description }` and warns when either is missing, when the description runs
 * past 160 characters, or when the page has a "#" heading, since the page template renders meta.title as the H1.
 * Plain JavaScript, because the MDX loader imports it by path in a Node worker.
 *
 * @import {Element, Root, RootContent} from 'hast'
 * @import {VFile} from 'vfile'
 */

const DESCRIPTION_MAX = 160;
const SECTION_TEXT_MAX = 4000;
/** Attributes whose text a reader sees on the page, such as a Step's title or a Term's tip */
const SHOWN_ATTRIBUTES = new Set(["title", "tip", "caption", "path", "name", "method"]);

/**
 * @typedef {{depth: 2 | 3, id: string, text: string}} TocItem
 * @typedef {{id: string | null, heading: string | null, text: string, extra: string}} SearchSection
 * @typedef {{title?: string, description?: string}} PageMeta
 */

export default function rehypeDocs() {
  /**
   * @param {Root} tree
   * @param {VFile} file
   */
  return (tree, file) => {
    const where = docPath(file.path);
    const meta = readMeta(tree);
    if (meta === null) warn(where, "has no `export const meta = { title, description }`");
    else {
      if (meta.title === undefined) warn(where, "has no meta.title");
      if (meta.description === undefined) warn(where, "has no meta.description");
      else if (meta.description.length > DESCRIPTION_MAX)
        warn(where, `has a meta.description of ${meta.description.length} characters, over ${DESCRIPTION_MAX}`);
    }

    const { toc, sections, h1 } = collect(tree);
    if (h1) warn(where, 'has a "#" heading; the page template renders meta.title as the H1, so start at "##"');

    const source = typeof file.value === "string" ? file.value : new TextDecoder().decode(file.value);
    const docData = { toc, sections, markdown: pageMarkdown(source, tree, meta) };
    tree.children.push(exportConst("docData", docData));
  };
}

/** @param {string | undefined} path */
function docPath(path) {
  if (path === undefined) return "an MDX page";
  const at = path.lastIndexOf("/content/docs/");
  return at === -1 ? path : path.slice(at + "/content/docs/".length);
}

/**
 * @param {string} where
 * @param {string} message
 */
function warn(where, message) {
  console.warn(`[docs] ${where} ${message}`);
}

/**
 * The string value of a literal or of a template literal without expressions
 *
 * @param {any} node
 * @returns {string | undefined}
 */
function stringOf(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((/** @type {any} */ q) => q.value.cooked ?? q.value.raw).join("");
  }
  return undefined;
}

/**
 * @param {Root} tree
 * @returns {PageMeta | null}
 */
export function readMeta(tree) {
  for (const node of tree.children) {
    if (node.type !== "mdxjsEsm") continue;
    /** @type {any[]} */
    const body = node.data?.estree?.body ?? [];
    for (const statement of body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "VariableDeclaration") continue;
      for (const declarator of statement.declaration.declarations) {
        if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") continue;
        if (declarator.init?.type !== "ObjectExpression") return {};
        /** @type {PageMeta} */
        const meta = {};
        for (const property of declarator.init.properties) {
          if (property.type !== "Property") continue;
          const key = property.key.type === "Identifier" ? property.key.name : stringOf(property.key);
          const value = stringOf(property.value);
          if ((key === "title" || key === "description") && value !== undefined) meta[key] = value.trim();
        }
        return meta;
      }
    }
  }
  return null;
}

/**
 * The plain text of a node, the same way hast-util-to-string reads it for rehype-slug
 *
 * @param {any} node
 * @returns {string}
 */
export function textOf(node) {
  if (node.type === "text") return node.value;
  return Array.isArray(node.children) ? node.children.map(textOf).join("") : "";
}

/** @param {string} text */
function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** @param {string} text */
function clip(text) {
  if (text.length <= SECTION_TEXT_MAX) return text;
  const cut = text.lastIndexOf(" ", SECTION_TEXT_MAX);
  return text.slice(0, cut > SECTION_TEXT_MAX / 2 ? cut : SECTION_TEXT_MAX);
}

/** @param {Element} node */
function isMermaid(node) {
  const code = node.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code === undefined || code.type !== "element") return false;
  const classes = code.properties?.className;
  return Array.isArray(classes) && classes.includes("language-mermaid");
}

/**
 * The names in a block of code worth finding it by: identifiers, environment variables, packages, paths and flags of
 * three characters or more, each once
 *
 * @param {string} code
 */
export function codeNames(code) {
  const names = new Set();
  for (const match of code.matchAll(/[@$A-Za-z_][\w$@./:-]*[\w$]/g)) {
    const name = match[0];
    if (
      name.length >= 3 &&
      /[A-Za-z]{2}/.test(name) &&
      !/^(https?|const|let|var|import|from|export|await|async|return|function|true|false|null)$/.test(name)
    ) {
      names.add(name);
    }
  }
  return names;
}

/** Elements that sit inside a line of text, so no space is added after them */
const INLINE = new Set(["a", "abbr", "b", "code", "del", "em", "i", "kbd", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "u"]);

/**
 * @param {Root} tree
 * @returns {{toc: TocItem[], sections: SearchSection[], h1: boolean}}
 */
export function collect(tree) {
  /** @type {TocItem[]} */
  const toc = [];
  /**
   * The text of each section, and apart from it what a search should find but a snippet should not quote: the
   * tooltips' text, and each code block's names once, rather than the whole block
   *
   * @type {{id: string | null, heading: string | null, parts: string[], tips: string[], names: Set<string>}[]}
   */
  const open = [{ id: null, heading: null, parts: [], tips: [], names: new Set() }];
  let h1 = false;
  const section = () => /** @type {(typeof open)[number]} */ (open[open.length - 1]);

  /** @param {any} node */
  const visit = (node) => {
    let inline = false;
    switch (node.type) {
      case "text":
        section().parts.push(node.value);
        return;
      case "mdxjsEsm":
      case "mdxFlowExpression":
      case "mdxTextExpression":
      case "comment":
        return;
      case "element": {
        const tag = node.tagName;
        if (tag === "h1") h1 = true;
        if ((tag === "h2" || tag === "h3") && typeof node.properties?.id === "string") {
          const text = squash(textOf(node));
          toc.push({ depth: tag === "h2" ? 2 : 3, id: node.properties.id, text });
          open.push({ id: node.properties.id, heading: text, parts: [], tips: [], names: new Set() });
          return;
        }
        if (tag === "pre") {
          if (!isMermaid(node)) for (const name of codeNames(textOf(node))) section().names.add(name);
          return;
        }
        inline = INLINE.has(tag);
        break;
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        inline = node.type === "mdxJsxTextElement";
        for (const attribute of node.attributes ?? []) {
          if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value !== "string") continue;
          if (attribute.name === "tip") section().tips.push(attribute.value);
          else if (SHOWN_ATTRIBUTES.has(attribute.name) || (node.name === "Param" && attribute.name === "type")) {
            section().parts.push(` ${attribute.value} `);
          }
        }
        break;
      default:
        break;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
      // After a block, so that the last word of one paragraph never runs into the first of the next
      if (!inline) section().parts.push(" ");
    }
  };

  for (const child of tree.children) visit(child);
  const sections = open
    .map((s) => ({
      id: s.id,
      heading: s.heading,
      text: clip(squash(s.parts.join(""))),
      extra: clip(squash(`${s.tips.join(" ")} ${[...s.names].join(" ")}`)),
    }))
    .filter((s) => s.id !== null || s.text !== "" || s.extra !== "");
  return { toc, sections, h1 };
}

/**
 * The page as Markdown: the source without its ESM, under its title and description
 *
 * @param {string} source
 * @param {Root} tree
 * @param {PageMeta | null} meta
 */
export function pageMarkdown(source, tree, meta) {
  /** @type {[number, number][]} */
  const cuts = [];
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "mdxjsEsm" && start !== undefined && end !== undefined) cuts.push([start, end]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let body = "";
  let at = 0;
  for (const [start, end] of cuts) {
    if (start < at) continue;
    body += source.slice(at, start);
    at = end;
  }
  body += source.slice(at);
  body = body.replace(/^\s+/, "").replace(/\s*$/, "\n");
  const head = [meta?.title === undefined ? null : `# ${meta.title}`, meta?.description ?? null].filter(
    (line) => line !== null && line !== "",
  );
  return head.length === 0 ? body : `${head.join("\n\n")}\n\n${body}`;
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function estreeOf(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { type: "Literal", value };
  }
  if (Array.isArray(value)) return { type: "ArrayExpression", elements: value.map(estreeOf) };
  return {
    type: "ObjectExpression",
    properties: Object.entries(/** @type {Record<string, unknown>} */ (value))
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => ({
        type: "Property",
        key: { type: "Literal", value: key },
        value: estreeOf(v),
        kind: "init",
        method: false,
        shorthand: false,
        computed: false,
      })),
  };
}

/**
 * `export const <name> = <value>` as an MDX ESM node
 *
 * @param {string} name
 * @param {unknown} value
 * @returns {RootContent}
 */
function exportConst(name, value) {
  return /** @type {any} */ ({
    type: "mdxjsEsm",
    value: "",
    data: {
      estree: {
        type: "Program",
        sourceType: "module",
        body: [
          {
            type: "ExportNamedDeclaration",
            specifiers: [],
            source: null,
            attributes: [],
            declaration: {
              type: "VariableDeclaration",
              kind: "const",
              declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name }, init: estreeOf(value) }],
            },
          },
        ],
      },
    },
  });
}
