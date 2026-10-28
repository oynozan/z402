/**
 * The checks, with the paying fetch injected. Each service has a short script of steps. A step is one HTTP call, timed,
 * whose answer is checked against the contract (spec section 4) and printed as one line:
 *
 *   <service> <step> <status> <ms> ms <detail>
 *
 * A failed step says FAIL and why, and for a paid call also whether it was charged: a refusal that comes before the
 * voucher costs nothing, while a failure after it is counted by the client and paid for with its next voucher (spec
 * section 3.4). The paying fetch is used for the paid routes only. A free route gets the plain one, so that a route
 * that wrongly asks for payment fails its step instead of being paid for.
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { syntheticAgeFile } from "./age.js";
import {
  parseChunk,
  parseEmbeddings,
  parseHold,
  parseMarkdown,
  parseUpload,
  type Chunk,
  type Held,
  type Stored,
} from "./answers.js";
import { SERVICE_NAMES, type Flags, type ServiceName } from "./flags.js";
import { abortable, BodyTooLarge, clean, describeError, drain, excerpt, Failure, readBody } from "./http.js";

const PROMPT = "Say hello in five words.";
/** The start call returns the first chunk, so this is also the most paid calls the llm script makes */
const MAX_CHUNKS = 3;
const EMBEDDING_INPUT = ["hello world", "zcash"];
/** Far more than any real answer (a page is at most 1 MiB of markdown), so only a stream that never ends reaches it */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const TEXT_CHARS = 200;
const TITLE_CHARS = 80;

export interface FlowOptions {
  /** The base URL of each service to check, a service without one is skipped */
  services: Flags["services"];
  /** The page the markdown service is asked to fetch */
  page: string;
  /** Pays when a route answers 402 */
  paidFetch: typeof fetch;
  /** For the routes that are free, which must not pay. Default fetch */
  fetch?: typeof fetch;
  print: (line: string) => void;
  /** The zat the paying client has vouchered so far, which tells what a call cost and whether a failed one was charged */
  spent?: () => bigint;
  signal?: AbortSignal;
}

export interface StepResult {
  service: ServiceName;
  step: string;
  /** The HTTP status of the answer, ERR when there was none */
  status: number | "ERR";
  ms: number;
  ok: boolean;
  /** The call is paid for */
  paid: boolean;
  detail: string;
}

export interface FlowResult {
  /** At least one step ran, none failed and the run was not aborted */
  ok: boolean;
  aborted: boolean;
  steps: StepResult[];
}

export const formatStep = (r: StepResult): string => `${r.service} ${r.step} ${r.status} ${r.ms} ms ${clean(r.detail).trim()}`;

interface Context {
  o: FlowOptions;
  free: typeof fetch;
  steps: StepResult[];
  aborted: boolean;
}

interface Spec<T> {
  service: ServiceName;
  step: string;
  paid: boolean;
  /** The status of a good answer */
  expect: number;
  send: () => Promise<Response>;
  /** Reads and checks the body of a good answer, and throws Failure with what is wrong */
  read: (res: Response) => Promise<T>;
  detail: (value: T) => string;
}

/* Why a step failed */

function decoded<T>(res: Response, name: string, decode: (header: string) => T): T | undefined {
  const header = res.headers.get(name);
  if (header === null) return undefined;
  try {
    return decode(header);
  } catch {
    return undefined;
  }
}

/** The error code and the message or reason a service gives with a refusal, in the shape all four use */
async function errorText(res: Response): Promise<string> {
  let text: string;
  try {
    text = (await readBody(res, MAX_ERROR_BYTES)).toString("utf8");
  } catch (e) {
    if (e instanceof BodyTooLarge) return "a very long body";
    throw e;
  }
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const { error, message, reason } = body as Record<string, unknown>;
      const detail = [message, reason].find((x): x is string => typeof x === "string" && x !== "");
      if (typeof error === "string" && error !== "") {
        return `${excerpt(error, 80)}${detail === undefined ? "" : ` (${excerpt(detail, 120)})`}`;
      }
    }
  } catch {
    // Not JSON, so the text itself is the best there is
  }
  return excerpt(text, 120);
}

/** A 402 that came back after the voucher: the facilitator's refusal rides in one of the two headers */
async function paymentProblem(res: Response): Promise<string> {
  const settled = decoded(res, "PAYMENT-RESPONSE", decodePaymentResponseHeader);
  if (settled !== undefined && settled.success !== true) {
    return `payment not settled: ${excerpt(settled.errorReason ?? settled.errorMessage ?? "no reason given", 80)}`;
  }
  const required = decoded(res, "PAYMENT-REQUIRED", decodePaymentRequiredHeader);
  if (required?.error !== undefined && required.error !== "") return `payment refused: ${excerpt(required.error, 80)}`;
  const text = await errorText(res);
  return text === "" ? "the route asks for payment" : text;
}

async function unexpected(res: Response, expect: number): Promise<string> {
  const head = `expected ${expect}, got ${res.status}`;
  if (res.status >= 300 && res.status < 400) {
    return `${head}: redirected to ${excerpt(res.headers.get("location") ?? "nowhere", 100)} (not followed)`;
  }
  const why = res.status === 402 ? await paymentProblem(res) : await errorText(res);
  return why === "" ? head : `${head}: ${why}`;
}

/** A paid call that was delivered carries the receipt of its settlement; without one nothing was paid */
function receiptProblem(res: Response): string | undefined {
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (header === null) return "no payment receipt (PAYMENT-RESPONSE), so the route answered without being paid";
  const receipt = decoded(res, "PAYMENT-RESPONSE", decodePaymentResponseHeader);
  if (receipt === undefined) return "the payment receipt (PAYMENT-RESPONSE) cannot be read";
  return receipt.success === true ? undefined : `the payment was not settled: ${excerpt(receipt.errorReason ?? "no reason given", 80)}`;
}

/* One step */

/**
 * Why a call threw. The stock client has no scheme for a network it was not set up for and says so with the whole offer
 * as JSON, which is no line to read, so the network is named instead.
 */
function explain(e: unknown): string {
  const text = describeError(e);
  const network = /No network\/scheme registered[\s\S]*?"network":"([^"]+)"/.exec(text)?.[1];
  if (network !== undefined) {
    return `the service asks for payment on ${excerpt(network, 30)}, which this run is not set to pay on (see --network)`;
  }
  const json = text.indexOf(" {");
  return json > 0 ? text.slice(0, json) : text;
}

interface Outcome<T> {
  /** The status of the answer, ERR when there was none */
  status: number | "ERR";
  value?: T;
  /** Why the step failed, absent when it passed */
  problem?: string;
}

/** Sends the request and checks the answer, and never throws */
async function attempt<T>(s: Spec<T>): Promise<Outcome<T>> {
  let res: Response | undefined;
  try {
    res = await s.send();
    if (res.status !== s.expect) return { status: res.status, problem: await unexpected(res, s.expect) };
    const missing = s.paid ? receiptProblem(res) : undefined;
    if (missing !== undefined) return { status: res.status, problem: missing };
    return { status: res.status, value: await s.read(res) };
  } catch (e) {
    return { status: res?.status ?? "ERR", problem: e instanceof Failure ? e.message : explain(e) };
  } finally {
    if (res !== undefined) await drain(res);
  }
}

/** Read each time, as it changes while a call is in flight */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

async function run<T>(ctx: Context, s: Spec<T>): Promise<T | undefined> {
  const { signal, spent } = ctx.o;
  if (isAborted(signal)) {
    ctx.aborted = true;
    return undefined;
  }
  const before = s.paid ? spent?.() : undefined;
  const started = performance.now();
  let outcome: Outcome<T>;
  try {
    outcome = await abortable(attempt(s), signal);
  } catch (e) {
    outcome = { status: "ERR", problem: describeError(e) };
  }
  const ms = Math.round(performance.now() - started);
  if (isAborted(signal)) ctx.aborted = true;

  const charged = before === undefined ? 0n : (spent?.() ?? before) - before;
  const { problem } = outcome;
  const ok = problem === undefined;
  let detail: string;
  if (ok) detail = s.detail(outcome.value as T) + (charged > 0n ? ` (${charged} zat)` : "");
  else detail = `FAIL ${problem}` + (before === undefined ? "" : charged > 0n ? ` (charged ${charged} zat)` : " (not charged)");

  const result: StepResult = { service: s.service, step: s.step, status: outcome.status, ms, ok, paid: s.paid, detail };
  ctx.steps.push(result);
  ctx.o.print(formatStep(result));
  return ok ? outcome.value : undefined;
}

/* The requests. None follows a redirect: a paid request carries a voucher, which a service must not be able to send elsewhere. */

function init(ctx: Context, more: RequestInit = {}): RequestInit {
  return { redirect: "manual", ...(ctx.o.signal === undefined ? {} : { signal: ctx.o.signal }), ...more };
}

const json = (ctx: Context, body: unknown): RequestInit =>
  init(ctx, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function readJson(res: Response): Promise<unknown> {
  const text = (await readBody(res, MAX_ANSWER_BYTES)).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Failure(`the answer is not JSON: ${excerpt(text, 60)}`);
  }
}

/* The scripts */

const quoted = (text: string, max: number): string => JSON.stringify(excerpt(text, max));

function chunkDetail(c: Chunk): string {
  const end = c.done ? ` (done${c.finishReason === undefined ? "" : `, ${excerpt(c.finishReason, 40)}`})` : "";
  return `chunk ${c.index} ${quoted(c.text, TEXT_CHARS)}${end}`;
}

async function llm(ctx: Context, base: string): Promise<void> {
  const url = `${base}/v1/generate`;
  let stream: string | undefined;
  for (let index = 0; index < MAX_CHUNKS; index++) {
    const chunk = await run(ctx, {
      service: "llm",
      step: index === 0 ? "start" : "continue",
      paid: true,
      expect: 200,
      send: () => ctx.o.paidFetch(url, json(ctx, index === 0 ? { prompt: PROMPT } : { stream })),
      read: async (res) => parseChunk(await readJson(res), index, stream),
      detail: chunkDetail,
    });
    if (chunk === undefined || chunk.done) return;
    stream = chunk.stream;
  }
}

async function markdown(ctx: Context, base: string): Promise<void> {
  await run(ctx, {
    service: "markdown",
    step: "get",
    paid: true,
    expect: 200,
    send: () => ctx.o.paidFetch(`${base}/v1/markdown?url=${encodeURIComponent(ctx.o.page)}`, init(ctx)),
    read: async (res) => parseMarkdown(await readJson(res)),
    detail: (p) =>
      `${p.title === null ? "(no title)" : quoted(p.title, TITLE_CHARS)} ${p.length} chars${p.truncated ? " (truncated)" : ""}`,
  });
}

async function embeddings(ctx: Context, base: string): Promise<void> {
  await run(ctx, {
    service: "embeddings",
    step: "embed",
    paid: true,
    expect: 200,
    send: () => ctx.o.paidFetch(`${base}/v1/embeddings`, json(ctx, { input: EMBEDDING_INPUT })),
    read: async (res) => parseEmbeddings(await readJson(res), EMBEDDING_INPUT.length),
    detail: (v) =>
      `${v.vectors} vectors, ${v.dimensions} dimensions` +
      (v.model === undefined ? "" : `, model ${excerpt(v.model, 60)}`) +
      (v.tokens === undefined ? "" : `, ${v.tokens} tokens`),
  });
}

/** Reads the drop back, which must be the upload byte for byte, with the expiry the hold promised */
async function sameBytes(res: Response, file: Uint8Array, held: Held | undefined): Promise<{ expires: string | null }> {
  let body: Buffer;
  try {
    body = await readBody(res, file.length);
  } catch (e) {
    if (e instanceof BodyTooLarge) throw new Failure(`the answer is longer than the ${file.length} bytes uploaded`);
    throw e;
  }
  if (body.length !== file.length) throw new Failure(`the answer has ${body.length} bytes, the upload had ${file.length}`);
  const at = body.findIndex((byte, i) => byte !== file[i]);
  if (at >= 0) throw new Failure(`the bytes differ from the upload at byte ${at}`);
  const expires = res.headers.get("x-expires-at-height");
  if (held !== undefined && expires !== null && expires !== String(held.expiresAtHeight)) {
    throw new Failure(
      `X-Expires-At-Height is ${excerpt(expires, 20)}, the hold said ${held.expiresAtHeight}: the hold was not applied`,
    );
  }
  return { expires: expires === null ? null : excerpt(expires, 20) };
}

async function dropbox(ctx: Context, base: string): Promise<void> {
  const file = syntheticAgeFile();
  const upload: Stored | undefined = await run(ctx, {
    service: "dropbox",
    step: "upload",
    paid: true,
    expect: 201,
    send: () =>
      ctx.o.paidFetch(
        `${base}/v1/drops`,
        init(ctx, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }),
      ),
    read: async (res) => parseUpload(await readJson(res), file.length),
    detail: (d) => `id ${d.id}, ${d.size} bytes, held until block ${d.expiresAtHeight}`,
  });
  // Without an id that is safe to put in a URL there is nothing to hold, fetch or delete
  if (upload === undefined) return;
  const drop = `${base}/v1/drops/${encodeURIComponent(upload.id)}`;

  const held: Held | undefined = await run(ctx, {
    service: "dropbox",
    step: "hold",
    paid: true,
    expect: 200,
    send: () => ctx.o.paidFetch(`${drop}/hold`, init(ctx, { method: "POST" })),
    read: async (res) => parseHold(await readJson(res), upload),
    detail: (h) => `held until block ${h.expiresAtHeight}`,
  });

  // Whatever happened to the hold, the free routes are checked and the drop is removed
  await run(ctx, {
    service: "dropbox",
    step: "fetch",
    paid: false,
    expect: 200,
    send: () => ctx.free(drop, init(ctx)),
    read: (res) => sameBytes(res, file, held),
    detail: (r) => `${file.length} bytes identical${r.expires === null ? "" : `, expires at block ${r.expires}`}`,
  });

  await run(ctx, {
    service: "dropbox",
    step: "delete",
    paid: false,
    expect: 204,
    send: () =>
      ctx.free(drop, init(ctx, { method: "DELETE", headers: { authorization: `Bearer ${upload.deleteToken}` } })),
    read: async (res) => {
      await drain(res);
      const again = await ctx.free(drop, init(ctx));
      await drain(again);
      if (again.status !== 404) throw new Failure(`the drop can still be read after the delete (${again.status})`);
      return undefined;
    },
    detail: () => "deleted, then 404",
  });
}

const SCRIPTS: Record<ServiceName, (ctx: Context, base: string) => Promise<void>> = { llm, markdown, embeddings, dropbox };

export async function runFlow(o: FlowOptions): Promise<FlowResult> {
  const ctx: Context = { o, free: o.fetch ?? fetch, steps: [], aborted: false };
  for (const name of SERVICE_NAMES) {
    const base = o.services[name];
    if (base === undefined) continue;
    await SCRIPTS[name](ctx, base);
    if (ctx.aborted || isAborted(o.signal)) {
      ctx.aborted = true;
      break;
    }
  }
  const ok = !ctx.aborted && ctx.steps.length > 0 && ctx.steps.every((s) => s.ok);
  return { ok, aborted: ctx.aborted, steps: ctx.steps };
}
