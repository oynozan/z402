/**
 * A client for any OpenAI-compatible chat API (Ollama, vLLM, llama.cpp server, OpenRouter, Groq, Together) on the
 * global fetch: one streamed chat completion as text deltas, and the ids of the models the provider serves.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

/** What the provider said when its stream ended */
export interface ChatEnd {
  /** Such as "stop" or "length" */
  finishReason: string | undefined;
}

export interface LlmProvider {
  /** Yields the non-empty text deltas of one completion. An abort through `signal` rejects with the abort reason. */
  streamChat(r: ChatRequest): AsyncGenerator<string, ChatEnd, void>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {
  /** The status of the provider's answer, undefined when it never answered */
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface OpenAiProviderOptions {
  /** The API root without a trailing slash, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

/** Ollama lists "name:tag", so a configured name without a tag also matches "name:latest" */
export function listsModel(ids: readonly string[], model: string): boolean {
  return ids.includes(model) || (!model.includes(":") && ids.includes(`${model}:latest`));
}

const MAX_LINE_CHARS = 1 << 20;
const MAX_DETAIL_CHARS = 200;
const ERROR_BODY_BYTES = 4096;
const MAX_CAUSES = 4;

function prop(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The messages of an error and its causes, outermost first */
function describe(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  while (current instanceof Error && parts.length < MAX_CAUSES) {
    parts.push(current.message || ((current as NodeJS.ErrnoException).code ?? current.name));
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(": ") : String(e);
}

/** The lines of a text body without their line ending (CRLF, LF or a lone CR), including a last line that has none */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lineEnd = /\r\n|\r|\n/g;
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        lineEnd.lastIndex = start;
        const end = lineEnd.exec(pending);
        if (end === null) break;
        // A CR that ends what has arrived may be the first half of a CRLF
        if (end[0] === "\r" && end.index + 1 === pending.length && !done) break;
        yield pending.slice(start, end.index);
        start = end.index + end[0].length;
      }
      pending = pending.slice(start);
      if (done) {
        if (pending !== "") yield pending;
        return;
      }
      if (pending.length > MAX_LINE_CHARS) throw new Error("a line is over 1 MiB");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The data of each server-sent event, its data lines joined by newlines, a last event without its blank line too */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  let data: string[] | undefined;
  let size = 0;
  for await (const line of readLines(body)) {
    if (line === "") {
      if (data !== undefined) yield data.join("\n");
      data = undefined;
      size = 0;
      continue;
    }
    const colon = line.indexOf(":");
    if ((colon === -1 ? line : line.slice(0, colon)) !== "data") continue;
    const value = colon === -1 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
    size += value.length + 1;
    if (size > MAX_LINE_CHARS) throw new Error("an event is over 1 MiB");
    (data ??= []).push(value);
  }
  if (data !== undefined) yield data.join("\n");
}

export class OpenAiProvider implements LlmProvider {
  readonly #base: string;
  readonly #who: string;
  readonly #apiKey: string | undefined;
  readonly #model: string;

  constructor(o: OpenAiProviderOptions) {
    this.#base = o.baseUrl;
    // The origin leaves out any credentials in the URL, so it is safe in messages and logs
    this.#who = `the provider at ${new URL(o.baseUrl).origin}`;
    this.#apiKey = o.apiKey;
    this.#model = o.model;
  }

  async *streamChat(r: ChatRequest): AsyncGenerator<string, ChatEnd, void> {
    let status: number | undefined;
    try {
      const res = await fetch(`${this.#base}/chat/completions`, {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json", accept: "text/event-stream" }),
        body: JSON.stringify({ model: this.#model, messages: r.messages, max_tokens: r.maxTokens, stream: true }),
        signal: r.signal,
      });
      status = res.status;
      if (!res.ok) throw await this.#refusal(res);
      if (res.body === null) throw new ProviderError(`${this.#who} answered without a body`, status);

      let finishReason: string | undefined;
      for await (const event of readEvents(res.body)) {
        const data = event.trim();
        if (data === "") continue;
        if (data === "[DONE]") return { finishReason };
        const choice = this.#choice(data, status);
        const content = prop(prop(choice, "delta"), "content");
        if (typeof content === "string" && content !== "") yield content;
        const reason = prop(choice, "finish_reason");
        if (typeof reason === "string" && reason !== "") finishReason = reason;
      }
      // A clean end without [DONE] still counts when the provider said why it stopped
      if (finishReason === undefined) throw new ProviderError(`${this.#who} ended its stream before [DONE]`, status);
      return { finishReason };
    } catch (e) {
      throw this.#wrap(e, status, r.signal);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let status: number | undefined;
    try {
      const headers = this.#headers({ accept: "application/json" });
      const res = await fetch(`${this.#base}/models`, { headers, signal });
      status = res.status;
      if (!res.ok) throw await this.#refusal(res);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ProviderError(`${this.#who} listed its models in a body that is not JSON`, status);
      }
      const data = prop(body, "data");
      if (!Array.isArray(data)) throw new ProviderError(`${this.#who} listed its models without a data array`, status);
      return (data as unknown[]).flatMap((m) => {
        const id = prop(m, "id");
        // llama.cpp server builds that answer while loading list their model with "meta": null until it has loaded
        return typeof id === "string" && prop(m, "meta") !== null ? [id] : [];
      });
    } catch (e) {
      throw this.#wrap(e, status, signal);
    }
  }

  #headers(base: Record<string, string>): Record<string, string> {
    return this.#apiKey === undefined ? base : { ...base, authorization: `Bearer ${this.#apiKey}` };
  }

  /** The first choice of one stream event, which may also carry an error instead */
  #choice(data: string, status: number): unknown {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new ProviderError(`${this.#who} sent a stream event that is not JSON`, status);
    }
    const error = prop(event, "error");
    if (error !== undefined && error !== null) {
      throw new ProviderError(`${this.#who} reported an error mid-stream: ${this.#detail(error)}`, status);
    }
    const choices = prop(event, "choices");
    return Array.isArray(choices) ? (choices as unknown[])[0] : undefined;
  }

  async #refusal(res: Response): Promise<ProviderError> {
    const text = await readSome(res, ERROR_BODY_BYTES).catch(() => "");
    let detail: unknown = text;
    try {
      const body: unknown = JSON.parse(text);
      detail = prop(body, "error") ?? prop(body, "message") ?? text;
    } catch {
      // Not JSON, so the text is the detail
    }
    const shown = this.#detail(detail);
    return new ProviderError(`${this.#who} answered ${res.status}${shown === "" ? "" : `: ${shown}`}`, res.status);
  }

  /** A short single-line rendering of the provider's own words, with the API key masked */
  #detail(value: unknown): string {
    const message = prop(value, "message");
    let text = typeof message === "string" ? message : typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (this.#apiKey !== undefined) text = text.replaceAll(this.#apiKey, "[redacted]");
    text = text.replace(/[\x00-\x1f\x7f\s]+/g, " ").trim();
    return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...` : text;
  }

  /** Aborts pass through as they are; anything else becomes a ProviderError that keeps the cause */
  #wrap(e: unknown, status: number | undefined, signal: AbortSignal | undefined): unknown {
    if (e instanceof ProviderError || signal?.aborted === true) return e;
    return new ProviderError(`${this.#who} failed: ${describe(e)}`, status, { cause: e });
  }
}

/** At most `limit` bytes of a body as text, so an error page cannot fill memory */
async function readSome(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, limit));
}
