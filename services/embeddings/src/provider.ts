import type { EmbeddingsConfig } from "./config.js";

export class ProviderError extends Error {
  /** The HTTP status the provider answered with, undefined when it never answered */
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface EmbeddingItem {
  index: number;
  embedding: number[];
}

export interface Usage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbedResult {
  /** One vector per input, sorted by index */
  data: EmbeddingItem[];
  usage?: Usage;
}

export interface EmbeddingsProvider {
  embed(inputs: string[]): Promise<EmbedResult>;
  listModels(): Promise<string[]>;
}

/** A cold model load can take a while, the readiness check uses the short one */
const EMBED_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 5_000;
/**
 * The most a provider's answer may hold, so that one that never stops cannot fill the memory of the service. A vector of
 * 4096 numbers is about 100 KiB of JSON, and the room for each input is two and a half times that. A list of the models
 * of a big hosted provider is a few MB at the most.
 */
const EMBED_BASE_BYTES = 1024 * 1024;
const EMBED_BYTES_PER_INPUT = 256 * 1024;
const LIST_MAX_BYTES = 8 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function size(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Math.round(mib * 10) / 10} MiB`;
}

/** The body as text, or undefined once it is past `max` bytes, with the rest of it left unread */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A short cause for a request that got no answer, never the URL */
function reason(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return "timed out";
  const cause: unknown = e instanceof Error ? e.cause : undefined;
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  return code ?? (e instanceof Error ? e.message : String(e));
}

function hint(status: number): string {
  if (status === 401 || status === 403) return " (check EMBEDDINGS_API_KEY)";
  if (status === 404) return " (check EMBEDDINGS_BASE_URL)";
  return "";
}

/** A provider that does not count tokens reports 0, which cannot be right for text that is not blank */
function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const { prompt_tokens: prompt, total_tokens: total } = value;
  if (!isCount(prompt) || prompt < 1) return undefined;
  return { prompt_tokens: prompt, total_tokens: isCount(total) && total >= prompt ? total : prompt };
}

function parseEmbeddings(body: unknown, count: number, status: number): EmbedResult {
  const unusable = (why: string): ProviderError =>
    new ProviderError(`provider answered an unusable embeddings list (${why})`, status);

  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== count) {
    throw unusable(`expected ${count} items`);
  }
  const items: unknown[] = body.data;
  const seen = new Set<number>();
  const data: EmbeddingItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) throw unusable("an item is not an object");
    const { index, embedding } = item;
    if (!isCount(index) || index >= count || seen.has(index)) {
      throw unusable("an index is missing, repeated or out of range");
    }
    if (!Array.isArray(embedding) || embedding.length === 0) throw unusable("a vector is empty");
    const vector: unknown[] = embedding;
    if (!vector.every((n): n is number => typeof n === "number" && Number.isFinite(n))) {
      throw unusable("a vector holds something other than numbers");
    }
    if (data[0] !== undefined && vector.length !== data[0].embedding.length) {
      throw unusable("the vectors differ in length");
    }
    seen.add(index);
    data.push({ index, embedding: vector });
  }
  data.sort((a, b) => a.index - b.index);

  const usage = parseUsage(body.usage);
  return usage === undefined ? { data } : { data, usage };
}

function parseModelIds(body: unknown, status: number): string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new ProviderError("provider answered an unusable model list", status);
  }
  const items: unknown[] = body.data;
  return items.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : []));
}

export function createOpenAiProvider(c: Pick<EmbeddingsConfig, "baseUrl" | "apiKey" | "model">): EmbeddingsProvider {
  const base = c.baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = c.apiKey === undefined ? {} : { authorization: `Bearer ${c.apiKey}` };

  /** Errors never quote the provider's own words, some providers echo the key */
  async function call(
    path: string,
    limits: { timeoutMs: number; maxBytes: number },
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let status: number;
    let text: string | undefined;
    try {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...auth,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
      status = res.status;
      // What a failing provider says is never used, so it is not read
      if (status < 200 || status >= 300) res.body?.cancel().catch(() => undefined);
      else text = await readCapped(res, limits.maxBytes);
    } catch (e) {
      throw new ProviderError(`provider unreachable (${reason(e)})`, undefined, { cause: e });
    }
    if (status < 200 || status >= 300) throw new ProviderError(`provider answered ${status}${hint(status)}`, status);
    if (text === undefined) throw new ProviderError(`provider answer is larger than ${size(limits.maxBytes)}`, status);
    try {
      return { status, json: JSON.parse(text) };
    } catch (e) {
      throw new ProviderError("provider answered with a body that is not JSON", status, { cause: e });
    }
  }

  return {
    async embed(inputs) {
      const maxBytes = EMBED_BASE_BYTES + EMBED_BYTES_PER_INPUT * inputs.length;
      const limits = { timeoutMs: EMBED_TIMEOUT_MS, maxBytes };
      const { status, json } = await call("/embeddings", limits, { model: c.model, input: inputs });
      return parseEmbeddings(json, inputs.length, status);
    },
    async listModels() {
      const { status, json } = await call("/models", { timeoutMs: LIST_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES });
      return parseModelIds(json, status);
    },
  };
}
