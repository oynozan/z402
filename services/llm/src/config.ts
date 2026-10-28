/**
 * The LLM service's own variables (design §4.1). An empty variable counts as unset, and every error names the variable
 * at fault without quoting a secret.
 */
import { ConfigError, read, readInt, readOrFile, readUrl, type Env } from "@z402/service-kit";

export interface LlmConfig {
  /** OpenAI-compatible API root without a trailing slash, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Sent as a bearer token when set */
  apiKey: string | undefined;
  model: string;
  /** Output deltas per paid chunk */
  chunkTokens: number;
  /** Cap on one stream's output, and the largest maxTokens a request may ask for */
  maxTokens: number;
  /** Cap on the prompt, and separately on the system prompt */
  maxPromptChars: number;
  /** Streams that may be live at once */
  maxStreams: number;
  /** A stream nobody touched for this long is dropped and its generation stopped */
  streamIdleMs: number;
  /** How long a paid call waits for its chunk */
  chunkTimeoutMs: number;
}

export const LLM_DEFAULTS = {
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen2.5:0.5b",
  chunkTokens: 32,
  maxTokens: 1024,
  maxPromptChars: 8000,
  maxStreams: 64,
  streamIdleMs: 600_000,
  chunkTimeoutMs: 60_000,
} as const;

/** A paid call must answer within the 60 s the 402 promises (maxTimeoutSeconds) */
const MAX_CHUNK_TIMEOUT_MS = 60_000;
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;

export function loadLlmConfig(env: Env): LlmConfig {
  const apiKey = readOrFile(env, "LLM_API_KEY");
  if (apiKey !== undefined && !HEADER_SAFE_RE.test(apiKey)) {
    throw new ConfigError("LLM_API_KEY: expected printable ASCII without spaces");
  }
  const model = read(env, "LLM_MODEL") ?? LLM_DEFAULTS.model;
  if (model.trim() !== model) throw new ConfigError("LLM_MODEL: must not start or end with whitespace");

  return {
    baseUrl: readUrl(env, "LLM_BASE_URL", LLM_DEFAULTS.baseUrl),
    apiKey,
    model,
    chunkTokens: readInt(env, "LLM_CHUNK_TOKENS", LLM_DEFAULTS.chunkTokens, 1, 512),
    maxTokens: readInt(env, "LLM_MAX_TOKENS", LLM_DEFAULTS.maxTokens, 1, 32_768),
    maxPromptChars: readInt(env, "LLM_MAX_PROMPT_CHARS", LLM_DEFAULTS.maxPromptChars, 1, 1_000_000),
    maxStreams: readInt(env, "LLM_MAX_STREAMS", LLM_DEFAULTS.maxStreams, 1, 100_000),
    streamIdleMs: readInt(env, "LLM_STREAM_IDLE_MS", LLM_DEFAULTS.streamIdleMs, 1_000, 86_400_000),
    chunkTimeoutMs: readInt(env, "LLM_CHUNK_TIMEOUT_MS", LLM_DEFAULTS.chunkTimeoutMs, 1, MAX_CHUNK_TIMEOUT_MS),
  };
}
