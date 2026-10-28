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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

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
  async function call(path: string, timeoutMs: number, body?: unknown): Promise<{ status: number; json: unknown }> {
    let status: number;
    let text: string;
    try {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...auth,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new ProviderError(`provider unreachable (${reason(e)})`, undefined, { cause: e });
    }
    if (status < 200 || status >= 300) throw new ProviderError(`provider answered ${status}${hint(status)}`, status);
    try {
      return { status, json: JSON.parse(text) };
    } catch (e) {
      throw new ProviderError("provider answered with a body that is not JSON", status, { cause: e });
    }
  }

  return {
    async embed(inputs) {
      const { status, json } = await call("/embeddings", EMBED_TIMEOUT_MS, { model: c.model, input: inputs });
      return parseEmbeddings(json, inputs.length, status);
    },
    async listModels() {
      const { status, json } = await call("/models", LIST_TIMEOUT_MS);
      return parseModelIds(json, status);
    },
  };
}
