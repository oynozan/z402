/**
 * LLM inference sold per output chunk (design §4.1). `POST /v1/generate` with {prompt} starts a stream and returns its
 * first chunk; {stream} returns the next one. The agent stops paying whenever it has enough.
 *
 * Every refusal that can be decided without the provider is made in `prepare`, so it reaches the client on its unpaid
 * first attempt. The provider is first called once a start call is paid, so nothing is generated for free.
 */
import { createPaidService, onDelivered, type PaidRoute, type ServiceEnv } from "@z402-net/service-kit";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import type { LlmConfig } from "./config.js";
import { listsModel, OpenAiProvider, type ChatMessage, type LlmProvider } from "./provider.js";
import {
  StreamError,
  StreamRegistry,
  type Chunk,
  type Generation,
  type LlmStream,
  type StreamErrorKind,
} from "./streams.js";

export const GENERATE_PATH = "/v1/generate";

export interface LlmServiceOptions {
  env: ServiceEnv;
  config: LlmConfig;
  /** Default: the OpenAI-compatible API at config.baseUrl */
  provider?: LlmProvider;
  /** One line per event an operator should see; default stderr */
  log?: (line: string) => void;
}

export interface LlmService {
  app: Express;
  /** The streams being sold, for monitoring and tests */
  streams: StreamRegistry;
  /** Stops declaring and ends every generation, and so the calls waiting on one; the HTTP server is the caller's */
  close(): Promise<void>;
}

const MIN_BODY_BYTES = 64 * 1024;
/** The longest JSON spelling of one UTF-16 code unit, a \uXXXX escape */
const ESCAPED_BYTES_PER_CHAR = 6;
const READY_CACHE_MS = 10_000;
const READY_TIMEOUT_MS = 2_000;
const MAX_LISTED = 5;
const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE = 'expected a JSON object: {"prompt": ...} to start a stream or {"stream": ...} to continue one';
const START_FIELDS: ReadonlySet<string> = new Set(["prompt", "system", "maxTokens"]);
/** A surrogate that is not half of a pair, which JSON can carry as an escape but UTF-8 cannot */
const LONE_SURROGATE_RE = /\p{Cs}/u;
const LOCALS_KEY = "llm";

/** What a body asks for */
type Ask = { kind: "start"; generation: Generation } | { kind: "continue"; id: string };

/** What prepare hands to the handler for a paid call */
type Paid = { kind: "start"; generation: Generation } | { kind: "continue"; stream: LlmStream; index: number };

const FAILURES: Readonly<Record<StreamErrorKind, { status: number; error: string }>> = {
  failed: { status: 502, error: "provider_failed" },
  timeout: { status: 504, error: "chunk_timeout" },
  closed: { status: 503, error: "stream_closed" },
  finished: { status: 410, error: "stream_finished" },
  full: { status: 503, error: "too_many_streams" },
};

function carriesPayment(req: Request): boolean {
  return req.get("payment-signature") !== undefined || req.get("x-payment") !== undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function invalid(res: Response, detail: string): void {
  res.status(400).json({ error: "invalid_request", message: detail });
}

/**
 * Whether the client hung up before its answer was ready. Such a call gets a status that cancels settlement, since
 * nobody will receive it, and a delivery handler added from now on would never run.
 */
function gone(res: Response): boolean {
  if (!res.closed) return false;
  res.status(499).json({ error: "client_closed" });
  return true;
}

/** A JSON body parser with JSON refusals, sized for both prompts at their largest with every character escaped */
function jsonBody(config: LlmConfig): RequestHandler {
  const limit = Math.max(MIN_BODY_BYTES, 2 * ESCAPED_BYTES_PER_CHAR * config.maxPromptChars + 4096);
  // Not strict, so that a body like "hi" gets the usage message rather than a parse error
  const parse = express.json({ limit, strict: false });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      if (err === undefined) {
        next();
        return;
      }
      const type = (err as { type?: unknown }).type;
      if (type === "entity.too.large") {
        res.status(413).json({ error: "body_too_large", message: `the body is over ${limit} bytes` });
        return;
      }
      invalid(res, type === "entity.parse.failed" ? "the body is not valid JSON" : "the body cannot be read as JSON");
    });
  };
}

/** The start or continue call a body asks for, or why it is refused */
function readBody(body: unknown, c: LlmConfig): Ask | string {
  if (body === undefined) return `${USAGE}, sent with content-type: application/json`;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return USAGE;
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  const stranger = keys.find((k) => k !== "stream" && !START_FIELDS.has(k));
  if (stranger !== undefined) return `unknown field ${JSON.stringify(stranger.slice(0, 40))}`;

  if (Object.hasOwn(fields, "stream")) {
    if (Object.hasOwn(fields, "prompt")) return "send prompt to start a stream or stream to continue one, not both";
    if (keys.length > 1) return "a continue call takes only stream";
    const id = fields["stream"];
    if (typeof id !== "string" || id === "") return "stream must be the id from an earlier answer";
    return { kind: "continue", id };
  }
  if (!Object.hasOwn(fields, "prompt")) return USAGE;

  const { prompt, system, maxTokens } = fields;
  if (typeof prompt !== "string" || prompt.trim() === "") return "prompt must be a non-empty string";
  if (prompt.length > c.maxPromptChars) return `prompt must be at most ${c.maxPromptChars} characters`;
  // A provider refuses such text only once the call is paid
  if (LONE_SURROGATE_RE.test(prompt)) return "prompt must be valid Unicode text, without a lone surrogate";
  if (system !== undefined && typeof system !== "string") return "system must be a string";
  if (typeof system === "string" && system.length > c.maxPromptChars) {
    return `system must be at most ${c.maxPromptChars} characters`;
  }
  if (typeof system === "string" && LONE_SURROGATE_RE.test(system)) {
    return "system must be valid Unicode text, without a lone surrogate";
  }
  if (
    maxTokens !== undefined &&
    !(typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= c.maxTokens)
  ) {
    return `maxTokens must be a whole number from 1 to ${c.maxTokens}`;
  }
  const messages: ChatMessage[] = [];
  if (typeof system === "string" && system !== "") messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const cap = typeof maxTokens === "number" ? maxTokens : c.maxTokens;
  return { kind: "start", generation: { messages, maxTokens: cap } };
}

/** Why a continue call on this stream cannot be served, if it cannot */
function refusalOf(stream: LlmStream): { status: number; error: string } | undefined {
  if (stream.inFlight) return { status: 409, error: "stream_busy" };
  // A published chunk is always deliverable, even once the producer has stopped
  if (stream.chunk(stream.cursor) !== undefined) return undefined;
  if (stream.state === "failed") return { status: 502, error: "provider_failed" };
  if (stream.state === "done") return { status: 410, error: "stream_finished" };
  return undefined;
}

/**
 * The checks in front of the payment middleware. A paid continue call also claims its stream here rather than in the
 * handler, so a second paid call cannot slip in while the first one's voucher is being verified; every way the
 * response can end, a refused voucher included, releases the claim.
 */
function check(registry: StreamRegistry, c: LlmConfig): RequestHandler {
  return (req, res, next) => {
    // Nothing would ever release a claim taken for a client that already hung up
    if (res.closed) return;
    const body = readBody(req.body, c);
    if (typeof body === "string") {
      invalid(res, body);
      return;
    }
    if (body.kind === "start") {
      if (!registry.hasRoom()) {
        res.status(503).json({ error: "too_many_streams" });
        return;
      }
      if (carriesPayment(req)) res.locals[LOCALS_KEY] = { kind: "start", generation: body.generation } satisfies Paid;
      next();
      return;
    }

    const stream = STREAM_ID_RE.test(body.id) ? registry.get(body.id) : undefined;
    if (stream === undefined) {
      res.status(404).json({ error: "unknown_stream" });
      return;
    }
    const refusal = refusalOf(stream);
    if (refusal !== undefined) {
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }
    if (carriesPayment(req)) {
      const index = stream.claim();
      if (index === undefined) {
        res.status(409).json({ error: "stream_busy" });
        return;
      }
      onDelivered(res, { ok: () => stream.commit(index), failed: () => stream.release() });
      res.locals[LOCALS_KEY] = { kind: "continue", stream, index } satisfies Paid;
    }
    next();
  };
}

function failure(res: Response, e: unknown): void {
  const { status, error } = FAILURES[e instanceof StreamError ? e.kind : "failed"];
  res.status(status).json({ error });
}

async function deliver(res: Response, stream: LlmStream, index: number, timeoutMs: number): Promise<void> {
  let chunk: Chunk;
  try {
    chunk = await stream.waitFor(index, timeoutMs);
  } catch (e) {
    if (e instanceof StreamError && e.kind === "timeout") stream.failIfStalled(timeoutMs);
    failure(res, e);
    return;
  }
  if (gone(res)) return;
  const reason = chunk.final ? stream.finishReason : undefined;
  res.json({
    stream: stream.id,
    index,
    text: chunk.text,
    done: chunk.final,
    ...(reason !== undefined && { finishReason: reason }),
  });
}

/** Runs only once the payment middleware has verified the voucher; the call is settled after it answers */
function generate(registry: StreamRegistry, c: LlmConfig): RequestHandler {
  return async (_req, res) => {
    const paid = res.locals[LOCALS_KEY] as Paid | undefined;
    // prepare plans only a request that carries a payment, so one that somehow skipped the middleware does no work
    if (paid === undefined) {
      res.status(402).json({ error: "payment_required" });
      return;
    }
    if (paid.kind === "continue") {
      await deliver(res, paid.stream, paid.index, c.chunkTimeoutMs);
      return;
    }
    // The client may have hung up while its voucher was verified, and then nothing would ever release the new stream
    if (gone(res)) return;
    let stream: LlmStream;
    try {
      stream = registry.create(paid.generation);
    } catch (e) {
      failure(res, e);
      return;
    }
    // A start call that was not delivered leaves nobody holding the stream id, so its generation stops at once
    onDelivered(res, { ok: () => stream.commit(0), failed: () => registry.remove(stream.id) });
    await deliver(res, stream, 0, c.chunkTimeoutMs);
  };
}

/** Ready while the provider lists the model; the answer is reused for 10 s and every change is logged */
function modelReadiness(provider: LlmProvider, model: string, log: (line: string) => void): () => Promise<boolean> {
  let cached: { at: number; ready: Promise<boolean> } | undefined;
  let last: boolean | undefined;
  const report = (ready: boolean, why: string): boolean => {
    if (ready !== last) log(ready ? `ready: the provider lists ${model}` : `not ready: ${why}`);
    last = ready;
    return ready;
  };
  const probe = async (): Promise<boolean> => {
    try {
      const ids = await provider.listModels(AbortSignal.timeout(READY_TIMEOUT_MS));
      const shown = ids.slice(0, MAX_LISTED).join(", ") + (ids.length > MAX_LISTED ? ", ..." : "");
      return report(listsModel(ids, model), `the provider does not list ${model} (it lists ${shown || "none"})`);
    } catch (e) {
      return report(false, message(e));
    }
  };
  return () => {
    if (cached === undefined || Date.now() - cached.at > READY_CACHE_MS) cached = { at: Date.now(), ready: probe() };
    return cached.ready;
  };
}

function route(registry: StreamRegistry, c: LlmConfig): PaidRoute {
  const perCall = `one chunk of about ${c.chunkTokens} tokens per paid call`;
  return {
    method: "POST",
    path: GENERATE_PATH,
    description: `Streams ${c.model} output, ${perCall}: send {prompt} to start, then {stream} to continue.`,
    unit: "output chunk",
    note: "The operator sees your prompts. Open-weights model.",
    discovery: {
      bodyType: "json",
      input: { prompt: "Write a haiku about privacy." },
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: c.maxPromptChars, description: "Starts a stream" },
          system: { type: "string", maxLength: c.maxPromptChars, description: "System prompt, with prompt" },
          maxTokens: {
            type: "integer",
            minimum: 1,
            maximum: c.maxTokens,
            description: `Output cap in tokens, with prompt (default ${c.maxTokens})`,
          },
          stream: { type: "string", description: "Continues a stream: the id from an earlier answer" },
        },
        oneOf: [{ required: ["prompt"] }, { required: ["stream"] }],
        additionalProperties: false,
      },
      output: { example: { stream: "<id>", index: 0, text: "...", done: false } },
    },
    prepare: [jsonBody(c), check(registry, c)],
  };
}

export async function createLlmService(o: LlmServiceOptions): Promise<LlmService> {
  const { config } = o;
  const log = o.log ?? ((line: string) => console.error(`llm: ${line}`));
  const provider = o.provider ?? new OpenAiProvider(config);
  const registry = new StreamRegistry({
    provider,
    chunkTokens: config.chunkTokens,
    capacity: config.maxStreams,
    idleMs: config.streamIdleMs,
    onFailure: (e) => log(`generation failed: ${message(e)}`),
  });
  try {
    const paid = await createPaidService({
      env: o.env,
      service: { serviceName: "LLM inference", tags: ["llm", "inference", "text"], routes: [route(registry, config)] },
      ready: modelReadiness(provider, config.model, log),
    });
    paid.app.post(GENERATE_PATH, generate(registry, config));
    return {
      app: paid.app,
      streams: registry,
      close: async () => {
        await paid.close();
        registry.close();
      },
    };
  } catch (e) {
    registry.close();
    throw e;
  }
}
