// Discovery data is untrusted, so every value is quoted and characters that act on a terminal are dropped
import type { Json, RouteInput } from "./discovery-types";

export interface CallRoute {
  method: string;
  url: string;
  input: RouteInput | null;
}

const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$|^\[([^\]/]+)\]$/;
/** Controls other than tab and newline, and the bidi and zero-width marks, none of which belong in a pasted command */
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const CONTENT_TYPE: Record<"json" | "text", string> = { json: "application/json", text: "text/plain" };
const INLINE_MAX = 56;

export function printable(text: string): string {
  return text.replace(UNSAFE_RE, "");
}

/** One single-quoted shell word, safe for any text */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** JSON on one line with a space after each separator, as a person writes a short object */
export function inlineJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** The example on one line when it is short, else indented */
export function exampleJson(value: Json): string {
  const inline = inlineJson(value);
  return inline.length <= INLINE_MAX && !inline.includes("\n") ? inline : JSON.stringify(value, null, 2);
}

export interface ExampleBlock {
  label: "Path" | "Query" | "Body";
  code: string;
}

function isEmptyObject(value: Json): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** The example input as the detail shows it, a text body as it is and an empty JSON body not at all */
export function exampleBlocks(input: RouteInput | null): ExampleBlock[] {
  if (input === null) return [];
  const blocks: ExampleBlock[] = [];
  if (input.pathParams !== null) blocks.push({ label: "Path", code: exampleJson(input.pathParams) });
  if (input.queryParams !== null) blocks.push({ label: "Query", code: exampleJson(input.queryParams) });
  if (input.bodyType === "text" && typeof input.body === "string") {
    blocks.push({ label: "Body", code: input.body.replace(/\n$/, "") });
  } else if (input.bodyType !== null && !isEmptyObject(input.body)) {
    blocks.push({ label: "Body", code: exampleJson(input.body) });
  }
  return blocks.map((block) => ({ ...block, code: printable(block.code) }));
}

/**
 * The route's URL with its example path and query parameters filled in. A path example that would need escaping, such
 * as the drop box's "<drop id>", names the value rather than being one, so its parameter stays as the template has it.
 */
export function exampleUrl(route: CallRoute): string {
  let url: URL;
  try {
    url = new URL(route.url);
  } catch {
    return route.url;
  }
  const params = route.input?.pathParams ?? {};
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      const match = PARAM_RE.exec(segment);
      const value = match === null ? undefined : params[match[1] ?? match[2] ?? ""];
      return value === undefined || encodeURIComponent(value) !== value ? segment : value;
    })
    .join("/");
  for (const [name, value] of Object.entries(route.input?.queryParams ?? {})) url.searchParams.set(name, value);
  return url.href;
}

type Body =
  | { kind: "json"; value: Json }
  | { kind: "text"; text: string }
  | { kind: "form"; fields: [string, string][] };

function bodyOf(input: RouteInput | null): Body | null {
  if (input === null || input.bodyType === null) return null;
  const { body } = input;
  if (input.bodyType === "text") return { kind: "text", text: typeof body === "string" ? body : inlineJson(body) };
  if (input.bodyType === "form-data") {
    const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.entries(body) : [];
    return { kind: "form", fields: fields.map(([k, v]): [string, string] => [k, typeof v === "string" ? v : inlineJson(v)]) };
  }
  return { kind: "json", value: body };
}

/** An unpaid request with the route's example, shown without a text body's last newline so no quote stands alone */
export function curlCommand(route: CallRoute, { display = false }: { display?: boolean } = {}): string {
  const method = route.method.toUpperCase();
  const head = `curl -i${method === "GET" ? "" : ` -X ${method}`}`;
  const url = shellQuote(exampleUrl(route));
  const args: string[] = [];
  const body = bodyOf(route.input);
  if (body?.kind === "json") {
    args.push(`-H ${shellQuote(`content-type: ${CONTENT_TYPE.json}`)}`, `-d ${shellQuote(JSON.stringify(body.value))}`);
  } else if (body?.kind === "text") {
    const text = display ? body.text.replace(/\n$/, "") : body.text;
    args.push(`-H ${shellQuote(`content-type: ${CONTENT_TYPE.text}`)}`, `--data-binary ${shellQuote(text)}`);
  } else if (body?.kind === "form") {
    for (const [name, value] of body.fields) args.push(`-F ${shellQuote(`${name}=${value}`)}`);
  }
  // The URL gets a line of its own once there are more arguments, which keeps every line short enough not to wrap
  const command = args.length === 0 ? `${head} ${url}` : [head, url, ...args].join(" \\\n  ");
  return printable(command);
}

/** The same call through the stock client's wrapped fetch, which pays it */
export function paidFetchCall(route: CallRoute): string {
  const method = route.method.toUpperCase();
  const url = JSON.stringify(exampleUrl(route));
  const options: string[] = method === "GET" ? [] : [`method: ${JSON.stringify(method)}`];
  const body = bodyOf(route.input);
  const before: string[] = [];
  if (body?.kind === "json") {
    options.push(`headers: { "content-type": "${CONTENT_TYPE.json}" }`, `body: JSON.stringify(${inlineJson(body.value)})`);
  } else if (body?.kind === "text") {
    options.push(`headers: { "content-type": "${CONTENT_TYPE.text}" }`, `body: ${JSON.stringify(body.text)}`);
  } else if (body?.kind === "form") {
    before.push("const form = new FormData();");
    for (const [name, value] of body.fields) before.push(`form.append(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
    options.push("body: form");
  }
  const call = options.length === 0 ? `await paidFetch(${url});` : `await paidFetch(${url}, {\n  ${options.join(",\n  ")},\n});`;
  return printable([...before, call].join("\n"));
}
