/**
 * Reads the answer of each paid route (spec section 4) as strictly as the agents that depend on it would: every field
 * the smoke test uses is checked, and the first thing wrong is the reason the step failed. Nothing here is trusted, as
 * the answer comes from whatever listens at the URL that was given.
 */
import { Failure } from "./http.js";

type Fields = Record<string, unknown>;

export interface Chunk {
  stream: string;
  index: number;
  text: string;
  done: boolean;
  finishReason?: string;
}

export interface Page {
  title: string | null;
  length: number;
  truncated: boolean;
}

export interface Vectors {
  vectors: number;
  dimensions: number;
  model?: string;
  tokens?: number;
}

export interface Stored {
  id: string;
  deleteToken: string;
  size: number;
  tip: number;
  expiresAtHeight: number;
}

export interface Held {
  id: string;
  tip: number;
  expiresAtHeight: number;
}

/** The drop box makes 22 characters of base64url, and the id goes into a URL, so nothing else may pass */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The token goes into a header, so it is printable ASCII and nothing else */
const TOKEN = /^[!-~]{1,512}$/;
const MAX_STREAM_CHARS = 256;

function fields(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Failure("the answer is not a JSON object");
  return value as Fields;
}

function count(o: Fields, key: string): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Failure(`${key} is not a count`);
  return value;
}

export function parseChunk(value: unknown, index: number, stream: string | undefined): Chunk {
  const o = fields(value);
  const id = o["stream"];
  if (typeof id !== "string" || id === "" || id.length > MAX_STREAM_CHARS) {
    throw new Failure("stream is not a short non-empty string");
  }
  if (stream !== undefined && id !== stream) {
    throw new Failure(`stream ${JSON.stringify(id.slice(0, 40))} where ${JSON.stringify(stream.slice(0, 40))} was expected`);
  }
  if (typeof o["index"] !== "number") throw new Failure("index is not a number");
  if (o["index"] !== index) throw new Failure(`index ${o["index"]}, expected ${index}`);
  const text = o["text"];
  if (typeof text !== "string") throw new Failure("text is not a string");
  const done = o["done"];
  if (typeof done !== "boolean") throw new Failure("done is not a boolean");
  // A chunk is about LLM_CHUNK_TOKENS tokens, so only the last one, which holds what is left, can be empty
  if (text === "" && !done) throw new Failure("a chunk that is not the last has no text");
  if (text === "" && index === 0) throw new Failure("the stream ended with no text at all");
  const reason = o["finishReason"];
  if (reason !== undefined && typeof reason !== "string") throw new Failure("finishReason is not a string");
  return { stream: id, index, text, done, ...(reason === undefined ? {} : { finishReason: reason }) };
}

export function parseMarkdown(value: unknown): Page {
  const o = fields(value);
  const markdown = o["markdown"];
  if (typeof markdown !== "string") throw new Failure("markdown is not a string");
  if (markdown.trim() === "") throw new Failure("markdown is empty");
  const length = count(o, "length");
  const title = o["title"] ?? null;
  if (typeof title !== "string" && title !== null) throw new Failure("title is not a string or null");
  return { title, length, truncated: o["truncated"] === true };
}

export function parseEmbeddings(value: unknown, inputs: number): Vectors {
  const o = fields(value);
  const dimensions = o["dimensions"];
  if (typeof dimensions !== "number" || !Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Failure("dimensions is not a positive whole number");
  }
  const data = o["data"];
  if (!Array.isArray(data)) throw new Failure("data is not an array");
  if (data.length !== inputs) throw new Failure(`data has ${data.length} vector${data.length === 1 ? "" : "s"}, expected ${inputs}`);
  (data as unknown[]).forEach((entry, i) => {
    const e = fields(entry);
    if (e["index"] !== i) throw new Failure(`data[${i}] has index ${String(e["index"])}, expected ${i}`);
    const vector = e["embedding"];
    if (!Array.isArray(vector)) throw new Failure(`data[${i}].embedding is not an array`);
    if (vector.length !== dimensions) {
      throw new Failure(`data[${i}] has ${vector.length} numbers, but dimensions is ${dimensions}`);
    }
    (vector as unknown[]).forEach((x, j) => {
      if (typeof x !== "number" || !Number.isFinite(x)) throw new Failure(`data[${i}].embedding[${j}] is not a finite number`);
    });
  });
  const usage: unknown = o["usage"];
  const tokens = typeof usage === "object" && usage !== null ? (usage as Fields)["total_tokens"] : undefined;
  return {
    vectors: data.length,
    dimensions,
    ...(typeof o["model"] === "string" ? { model: o["model"] } : {}),
    ...(typeof tokens === "number" && Number.isSafeInteger(tokens) ? { tokens } : {}),
  };
}

export function parseUpload(value: unknown, size: number): Stored {
  const o = fields(value);
  const id = o["id"];
  if (typeof id !== "string" || !ID.test(id)) throw new Failure("id is not a plain drop id, so no later request would be safe");
  const deleteToken = o["deleteToken"];
  if (typeof deleteToken !== "string" || !TOKEN.test(deleteToken)) {
    throw new Failure("deleteToken is missing or not a printable token");
  }
  const stored = count(o, "size");
  if (stored !== size) throw new Failure(`size ${stored}, but ${size} bytes were uploaded`);
  const tip = count(o, "tip");
  const expiresAtHeight = count(o, "expiresAtHeight");
  if (expiresAtHeight <= tip) throw new Failure(`expiresAtHeight ${expiresAtHeight} is not after the tip ${tip}`);
  return { id, deleteToken, size: stored, tip, expiresAtHeight };
}

export function parseHold(value: unknown, upload: Stored): Held {
  const o = fields(value);
  if (o["id"] !== upload.id) {
    throw new Failure(`id ${JSON.stringify(String(o["id"]).slice(0, 40))} is not the drop ${upload.id}`);
  }
  const tip = count(o, "tip");
  const expiresAtHeight = count(o, "expiresAtHeight");
  if (expiresAtHeight <= upload.expiresAtHeight) {
    throw new Failure(`expiresAtHeight ${expiresAtHeight} is not after the ${upload.expiresAtHeight} the drop had`);
  }
  return { id: upload.id, tip, expiresAtHeight };
}
