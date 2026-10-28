import { ConfigError, read, readInt, readOrFile, readUrl, type Env } from "@z402/service-kit";

export interface EmbeddingsConfig {
  /** Without a trailing slash */
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Most Unicode code points one call may embed, summed over all inputs */
  maxChars: number;
  /** Most code points in one input string, which a local model with a short context needs */
  maxInputChars: number;
  maxInputs: number;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_INPUTS = 64;
/** The paid route reads at most 256 kB of JSON, which carries this many characters even at four bytes each */
const MAX_CHARS_LIMIT = 60_000;
const MAX_INPUTS_LIMIT = 2048;
/** Visible ASCII without spaces, which is what a bearer token can carry */
const KEY_RE = /^[\x21-\x7e]+$/;

export function loadEmbeddingsConfig(env: Env): EmbeddingsConfig {
  const baseUrl = readUrl(env, "EMBEDDINGS_BASE_URL", DEFAULT_BASE_URL);
  const { username, password } = new URL(baseUrl);
  if (username !== "" || password !== "") {
    throw new ConfigError("EMBEDDINGS_BASE_URL: must not contain credentials (use EMBEDDINGS_API_KEY)");
  }

  // A trailing newline from an env file would otherwise break the header at the first request
  const apiKey = readOrFile(env, "EMBEDDINGS_API_KEY")?.trim() || undefined;
  if (apiKey !== undefined && !KEY_RE.test(apiKey)) {
    throw new ConfigError("EMBEDDINGS_API_KEY: expected visible ASCII characters without spaces");
  }

  const model = (read(env, "EMBEDDINGS_MODEL") ?? DEFAULT_MODEL).trim();
  if (model === "") throw new ConfigError("EMBEDDINGS_MODEL: must not be blank");

  return {
    baseUrl,
    apiKey,
    model,
    maxChars: readInt(env, "EMBEDDINGS_MAX_CHARS", DEFAULT_MAX_CHARS, 1, MAX_CHARS_LIMIT),
    maxInputChars: readInt(env, "EMBEDDINGS_MAX_INPUT_CHARS", MAX_CHARS_LIMIT, 1, MAX_CHARS_LIMIT),
    maxInputs: readInt(env, "EMBEDDINGS_MAX_INPUTS", DEFAULT_MAX_INPUTS, 1, MAX_INPUTS_LIMIT),
  };
}
