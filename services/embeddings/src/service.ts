/**
 * The embeddings service (design §4.3) with one paid route, POST /v1/embeddings, billed per call at about 1,000
 * tokens. Everything that can refuse a call runs in prepare, before payment, so a body that is invalid or too long is
 * answered on the unpaid attempt and never counted against the client. The handler after payment only embeds.
 */
import {
  createPaidService,
  type PaidRoute,
  type PaidService,
  type ServiceDefinition,
  type ServiceEnv,
} from "@z402/service-kit";
import express, { type RequestHandler, type Response } from "express";
import type { EmbeddingsConfig } from "./config.js";
import { createOpenAiProvider, type EmbeddingsProvider, type EmbedResult, type Usage } from "./provider.js";

export interface EmbeddingsServiceOptions {
  env: ServiceEnv;
  config: EmbeddingsConfig;
  provider?: EmbeddingsProvider;
  /** Where operational lines go, stderr by default, and nothing secret is ever passed to it */
  log?: (line: string) => void;
}

export const EMBEDDINGS_PATH = "/v1/embeddings";

/**
 * What a body may weigh: room for `EMBEDDINGS_MAX_CHARS` characters at 12 bytes each, which is a character outside the
 * BMP written as two \uXXXX escapes, the way a client that escapes everything writes it, and for the quotes, commas and
 * indents between the strings. 256 kB is the least, which is also what the default caps need many times over.
 */
const MIN_JSON_BYTES = 256 * 1024;
const BYTES_PER_CHAR = 12;
const BYTES_PER_STRING = 16;
const BODY_SLACK_BYTES = 4096;
/** The kit asks for readiness every 5 s, so the provider hears from us about every 10 s */
const READY_CACHE_MS = 10_000;
/** For a provider that reports no usage, about four characters to a token */
const CHARS_PER_TOKEN = 4;
/** Where `prepare` leaves the normalized inputs for the handler */
const INPUTS_KEY = "embeddingInputs";

function jsonLimit(c: EmbeddingsConfig): number {
  return Math.max(MIN_JSON_BYTES, c.maxChars * BYTES_PER_CHAR + c.maxInputs * BYTES_PER_STRING + BODY_SLACK_BYTES);
}

// A lone surrogate is not text: JSON.stringify writes it as an escape, and a strict provider refuses the whole body
const LONE_SURROGATE_RE = /\p{Surrogate}/u;
const NOT_UNICODE = "must be valid Unicode text, with no unpaired surrogate";

/** Unicode code points, so that an emoji counts once whatever its UTF-16 length */
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

// A blank string can make a provider fail, which would only show after payment
const isBlank = (s: string): boolean => s.trim() === "";

type Parsed = { inputs: string[] } | { message: string };

function parseInput(body: unknown, maxInputs: number): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { message: "send a JSON object with an input field (Content-Type: application/json)" };
  }
  const input: unknown = (body as { input?: unknown }).input;
  if (typeof input === "string") {
    if (isBlank(input)) return { message: "input must not be blank" };
    return LONE_SURROGATE_RE.test(input) ? { message: `input ${NOT_UNICODE}` } : { inputs: [input] };
  }
  if (!Array.isArray(input)) return { message: "input must be a string or an array of strings" };
  if (input.length === 0 || input.length > maxInputs) return { message: `input must hold 1 to ${maxInputs} strings` };
  const items: unknown[] = input;
  const bad = items.findIndex((s) => typeof s !== "string" || isBlank(s));
  if (bad >= 0) return { message: `input[${bad}] must be a string that is not blank` };
  const strings = items as string[];
  const broken = strings.findIndex((s) => LONE_SURROGATE_RE.test(s));
  if (broken >= 0) return { message: `input[${broken}] ${NOT_UNICODE}` };
  return { inputs: strings };
}

/** Parses the JSON body and checks it, answering the refusal itself so that no voucher is ever sent for it */
function checkRequest(config: EmbeddingsConfig): RequestHandler {
  // Not strict, so that a JSON string or number reaches parseInput and gets its own message
  const parseJson = express.json({ limit: jsonLimit(config), strict: false });
  const tooLong = (res: Response): void => {
    res.status(413).json({
      error: "too_many_tokens",
      maxChars: config.maxChars,
      ...(config.maxInputChars < config.maxChars && { maxInputChars: config.maxInputChars }),
    });
  };
  const invalid = (res: Response, message: string): void => {
    res.status(400).json({ error: "invalid_request", message });
  };
  return (req, res, next) => {
    parseJson(req, res, (err?: unknown) => {
      if (err !== undefined) {
        const status = typeof err === "object" && err !== null && "status" in err ? err.status : undefined;
        if (status === 413) tooLong(res);
        else invalid(res, "the body is not valid JSON");
        return;
      }
      const parsed = parseInput(req.body, config.maxInputs);
      if ("message" in parsed) {
        invalid(res, parsed.message);
        return;
      }
      const lengths = parsed.inputs.map(codePoints);
      if (lengths.reduce((n, l) => n + l, 0) > config.maxChars || lengths.some((l) => l > config.maxInputChars)) {
        tooLong(res);
        return;
      }
      res.locals[INPUTS_KEY] = parsed.inputs;
      next();
    });
  };
}

function inputsOf(res: Response): string[] {
  const inputs: unknown = res.locals[INPUTS_KEY];
  if (!Array.isArray(inputs) || !inputs.every((s) => typeof s === "string")) {
    throw new Error("the paid handler ran without the request checks");
  }
  return inputs;
}

function route(config: EmbeddingsConfig): PaidRoute {
  const { maxInputs, maxChars, maxInputChars } = config;
  const perInput = maxInputChars < maxChars ? `, at most ${maxInputChars} per string` : "";
  // JSON Schema counts a length in code points, as the checks before payment do
  const maxLength = Math.min(maxChars, maxInputChars);
  return {
    method: "POST",
    path: EMBEDDINGS_PATH,
    description: "Embeds up to about 1,000 tokens of text per paid call (OpenAI-style request and answer).",
    unit: "1k tokens",
    note: "About 1,000 tokens per call.",
    discovery: {
      bodyType: "json",
      input: { input: ["The quick brown fox"] },
      inputSchema: {
        type: "object",
        properties: {
          input: {
            description: `A string, or up to ${maxInputs} strings, with at most ${maxChars} characters in total${perInput}`,
            oneOf: [
              { type: "string", minLength: 1, maxLength },
              { type: "array", minItems: 1, maxItems: maxInputs, items: { type: "string", minLength: 1, maxLength } },
            ],
          },
        },
        required: ["input"],
      },
      output: {
        example: {
          object: "list",
          model: config.model,
          dimensions: 3,
          data: [{ object: "embedding", index: 0, embedding: [0.0123, -0.0456, 0.0789] }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        },
      },
    },
    prepare: [checkRequest(config)],
  };
}

function definition(config: EmbeddingsConfig): ServiceDefinition {
  return { serviceName: "Text embeddings", tags: ["embeddings", "vectors", "rag"], routes: [route(config)] };
}

/** A model and its latest tag are one model, and Ollama lists the tagged form */
const bare = (id: string): string => (id.endsWith(":latest") ? id.slice(0, -":latest".length) : id);

/** Whether the provider lists the model, asked once per READY_CACHE_MS and logged whenever the answer changes */
function providerReady(
  config: EmbeddingsConfig,
  provider: EmbeddingsProvider,
  log: (line: string) => void,
): () => Promise<boolean> {
  let last: boolean | undefined;
  let cached: { at: number; ready: Promise<boolean> } | undefined;

  const check = async (): Promise<boolean> => {
    let problem: string | undefined;
    try {
      const ids = await provider.listModels();
      if (!ids.some((id) => bare(id) === bare(config.model))) problem = `the provider does not list ${config.model}`;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    const ready = problem === undefined;
    if (ready !== last) {
      last = ready;
      log(ready ? `embeddings: provider ready, it lists ${config.model}` : `embeddings: not ready, ${problem}`);
    }
    return ready;
  };

  return () => {
    if (cached === undefined || Date.now() - cached.at >= READY_CACHE_MS) cached = { at: Date.now(), ready: check() };
    return cached.ready;
  };
}

/** At least one token for each input, otherwise about four characters to a token */
function estimateUsage(inputs: string[]): Usage {
  const tokens = inputs.reduce((n, s) => n + Math.max(1, Math.ceil(codePoints(s) / CHARS_PER_TOKEN)), 0);
  return { prompt_tokens: tokens, total_tokens: tokens };
}

function embeddingsHandler(
  config: EmbeddingsConfig,
  provider: EmbeddingsProvider,
  log: (line: string) => void,
): RequestHandler {
  return async (_req, res) => {
    const inputs = inputsOf(res);
    let result: EmbedResult;
    try {
      result = await provider.embed(inputs);
    } catch (e) {
      log(`embeddings: the provider failed after payment, ${e instanceof Error ? e.message : String(e)}`);
      res.status(502).json({ error: "provider_failed" });
      return;
    }
    res.json({
      object: "list",
      model: config.model,
      dimensions: result.data[0]?.embedding.length ?? 0,
      data: result.data.map((d) => ({ object: "embedding", index: d.index, embedding: d.embedding })),
      usage: result.usage ?? estimateUsage(inputs),
      ...(result.usage === undefined && { usageEstimated: true }),
    });
  };
}

export async function createEmbeddingsService(o: EmbeddingsServiceOptions): Promise<PaidService> {
  const { env, config } = o;
  const provider = o.provider ?? createOpenAiProvider(config);
  const log = o.log ?? ((line: string) => console.error(line));

  const service = await createPaidService({
    env,
    service: definition(config),
    ready: providerReady(config, provider, log),
  });
  // After the kit's payment middleware, so it only runs for a paid call
  service.app.post(EMBEDDINGS_PATH, embeddingsHandler(config, provider, log));
  return service;
}
