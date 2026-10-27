/**
 * The facilitator's HTTP face and its start-up (design §3 and §4.3 to §4.5, protocol.md §7.1).
 *
 * POST /verify and /settle answer HTTP 200 whatever happens, since a 500 leaks its body into the client's error and a
 * 4xx has no place in the schema. Only a missing or wrong token (401) and an unknown route (404) are not 200.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  encodeTerms,
  isValidPayTo,
  isZcashNetwork,
  parseTerms,
  REASON,
  ZCASH_NETWORKS,
  type ChainView,
  type ReasonCode,
  type Terms,
  type ZcashNetwork,
} from "@z402/protocol";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { Ledger, type LedgerEvent } from "./core/ledger.js";
import { DepositResolver } from "./core/resolver.js";
import { commit, FacilitatorState } from "./core/state.js";
import { ChainWatcher } from "./core/watcher.js";
import { PrepaidVoucherFacilitatorScheme } from "./scheme.js";

type Log = (msg: string, err?: unknown) => void;

const stderr: Log = (msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err));

export interface FacilitatorOptions {
  network: ZcashNetwork;
  chain: ChainView;
  payTo: string;
  priceZat: bigint;
  terms: Terms;
  /** Bearer token callers must present, nothing is checked when it is left out */
  authToken?: string;
  /** JSON Lines ledger replayed at start, left out means an in-memory ledger and no file I/O */
  ledgerPath?: string;
  /** Default 127.0.0.1 */
  host?: string;
  /** Default 0 picks a free port, read the real one from url */
  port?: number;
  /** Default 5000 */
  pollIntervalMs?: number;
  /** How long verify waits for a deposit the chain does not show yet, default 30000 */
  depositWaitMs?: number;
  /** Called once, on the first failed ledger write in settle or the watcher, the host should exit to replay the file */
  onFatal?: (err: unknown) => void;
  /** Receives one line per request (method, path, status, reason code) and the diagnostics, which default to stderr */
  log?: Log;
}

export interface FacilitatorHandle {
  url: string;
  /** One best effort pass over every live deposit, which does nothing once closed */
  pollNow(): Promise<void>;
  /** Stops the watcher and the server, and a pass still in flight no longer writes to the ledger */
  close(): Promise<void>;
}

interface Refusal {
  code: ReasonCode;
  message: string;
}

type Read = { ok: true; payload: PaymentPayload; requirements: PaymentRequirements } | { ok: false; refusal: Refusal };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_POLL_MS = 5000;
const DEFAULT_DEPOSIT_WAIT_MS = 30_000;
const BODY_LIMIT = "64kb";
const MAX_LOGGED_PATH = 120;
/** CAIP-2 ids are at most 41 characters, so anything longer is not worth echoing back */
const MAX_NETWORK_LENGTH = 64;
const BEARER = /^bearer (.+)$/i;
const EMPTY_TOKEN = "authToken: must not be empty (leave it out to run without a token)";

const BAD_VERSION: Refusal = { code: REASON.invalidX402Version, message: "x402Version must be 2" };
const UNSUPPORTED: Refusal = {
  code: REASON.unsupportedScheme,
  message: "this facilitator does not support the requested scheme and network",
};
const UNEXPECTED_VERIFY: Refusal = { code: REASON.unexpectedVerifyError, message: "the facilitator failed to verify" };
const UNEXPECTED_SETTLE: Refusal = { code: REASON.unexpectedSettleError, message: "the facilitator failed to settle" };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

const verifyRefused = (r: Refusal): VerifyResponse => ({
  isValid: false,
  invalidReason: r.code,
  invalidMessage: r.message,
});

const settleRefused = (r: Refusal, network: Network): SettleResponse => ({
  success: false,
  errorReason: r.code,
  errorMessage: r.message,
  transaction: "",
  network,
});

/** The first thing wrong with a schema's input, by path and rule and never by value */
function describeIssue(
  which: string,
  error: { issues: Array<{ path: Array<string | number>; message: string }> },
): string {
  const issue = error.issues[0];
  return `${[which, ...(issue?.path ?? [])].join(".")}: ${issue?.message ?? "invalid"}`;
}

/** What `x402Facilitator` throws when no scheme answers to the requirements, the one throw that is not a bug */
function isUnregistered(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("No facilitator registered for ");
}

function readRequest(body: unknown, unreadable: unknown): Read {
  const bad = (message: string): Read => ({ ok: false, refusal: { code: REASON.invalidPayload, message } });
  if (typeof unreadable === "string") return bad(unreadable);
  if (!isRecord(body)) return bad("the request body must be a JSON object");

  const { paymentPayload, paymentRequirements } = body;
  // The v2 schema pins x402Version to 2 and would call any other payload invalid, so the version is told apart first
  if (isRecord(paymentPayload) && paymentPayload.x402Version !== undefined && paymentPayload.x402Version !== 2) {
    return { ok: false, refusal: BAD_VERSION };
  }
  const payload = PaymentPayloadV2Schema.safeParse(paymentPayload);
  if (!payload.success) return bad(describeIssue("paymentPayload", payload.error));
  const requirements = PaymentRequirementsV2Schema.safeParse(paymentRequirements);
  if (!requirements.success) return bad(describeIssue("paymentRequirements", requirements.error));
  // The raw values go on, since the schemas strip what they do not know and the scheme reads only what it needs
  return {
    ok: true,
    payload: paymentPayload as PaymentPayload,
    requirements: paymentRequirements as PaymentRequirements,
  };
}

function accessLog(log: Log | undefined): RequestHandler {
  return (req, res, next) => {
    if (log !== undefined) {
      res.on("finish", () => {
        const path = req.path.replace(/[^\x21-\x7e]/g, "?");
        const shown = path.length > MAX_LOGGED_PATH ? `${path.slice(0, MAX_LOGGED_PATH)}...` : path;
        const reason = typeof res.locals.reason === "string" ? ` ${res.locals.reason}` : "";
        // A logger that throws must not take the process down from an event handler
        try {
          log(`${req.method} ${shown} ${res.statusCode}${reason}`);
        } catch {}
      });
    }
    next();
  };
}

function bearer(token: string): RequestHandler {
  const expected = digest(token);
  return (req, res, next) => {
    const header = req.get("authorization");
    const presented = header === undefined ? undefined : BEARER.exec(header)?.[1];
    // Both sides are hashed first, so the comparison takes the same time whatever the lengths
    if (presented !== undefined && timingSafeEqual(digest(presented), expected)) {
      next();
      return;
    }
    res.set("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
  };
}

function jsonBody(): RequestHandler {
  const parse = express.json({ limit: BODY_LIMIT });
  return (req, res, next) => {
    parse(req, res, (err?: unknown) => {
      // The route answers a body it cannot read like any other bad payload, never with the parser's own status
      if (err !== undefined)
        res.locals.unreadable = `the request body is not JSON or is over ${BODY_LIMIT.toUpperCase()}`;
      next();
    });
  };
}

export function createFacilitatorApp(o: { facilitator: x402Facilitator; authToken?: string; log?: Log }): Express {
  const { facilitator, authToken, log } = o;
  if (authToken === "") throw new Error(EMPTY_TOKEN);
  const diagnose = log ?? stderr;

  /** The network a failed settle names when the request gave no usable one, which is the one registered here */
  const ownNetwork = (): string => {
    try {
      return facilitator.getSupported().kinds[0]?.network ?? "";
    } catch {
      return "";
    }
  };
  const networkOf = (body: unknown): Network => {
    const requirements = isRecord(body) ? body.paymentRequirements : undefined;
    const sent = isRecord(requirements) ? requirements.network : undefined;
    return (typeof sent === "string" && sent.length <= MAX_NETWORK_LENGTH ? sent : ownNetwork()) as Network;
  };

  async function verify(read: Read): Promise<VerifyResponse> {
    if (!read.ok) return verifyRefused(read.refusal);
    try {
      return await facilitator.verify(read.payload, read.requirements);
    } catch (e) {
      if (isUnregistered(e)) return verifyRefused(UNSUPPORTED);
      diagnose("verify failed unexpectedly", e);
      return verifyRefused(UNEXPECTED_VERIFY);
    }
  }

  async function settle(read: Read, network: Network): Promise<SettleResponse> {
    if (!read.ok) return settleRefused(read.refusal, network);
    try {
      return await facilitator.settle(read.payload, read.requirements);
    } catch (e) {
      if (isUnregistered(e)) return settleRefused(UNSUPPORTED, network);
      diagnose("settle failed unexpectedly", e);
      return settleRefused(UNEXPECTED_SETTLE, network);
    }
  }

  const app = express();
  app.disable("x-powered-by");
  // Request lines are opt-in, so the log goes in as given and not as the stderr default
  app.use(accessLog(log));
  if (authToken !== undefined) app.use(bearer(authToken));
  app.use(jsonBody());

  app.get("/supported", (_req: Request, res: Response) => {
    res.json(facilitator.getSupported());
  });

  app.post("/verify", async (req: Request, res: Response) => {
    const result = await verify(readRequest(req.body, res.locals.unreadable));
    res.locals.reason = result.invalidReason;
    res.json(result);
  });

  app.post("/settle", async (req: Request, res: Response) => {
    const result = await settle(readRequest(req.body, res.locals.unreadable), networkOf(req.body));
    res.locals.reason = result.errorReason;
    res.json(result);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // Last resort for what no route caught, which says nothing about the cause
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    diagnose("request failed", err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

function wholeNumber(name: string, value: number | undefined, min: number, max = Number.POSITIVE_INFINITY): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `of at least ${min}` : `from ${min} to ${max}`;
    throw new Error(`${name}: expected a whole number ${range}`);
  }
}

/** Refuses a bad option before anything is opened, naming the field */
function checkOptions(o: FacilitatorOptions): void {
  if (!isZcashNetwork(o.network)) throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
  if (!isValidPayTo(o.payTo, o.network)) throw new Error(`payTo: not a shielded-only unified address for ${o.network}`);
  if (typeof o.priceZat !== "bigint" || o.priceZat < 1n)
    throw new Error("priceZat: must be a bigint of at least 1 zat");
  try {
    parseTerms(encodeTerms(o.terms));
  } catch (e) {
    throw new Error(`terms: ${text(e)}`);
  }
  if (o.authToken === "") throw new Error(EMPTY_TOKEN);
  wholeNumber("port", o.port, 0, 65535);
  wholeNumber("pollIntervalMs", o.pollIntervalMs, 1);
  wholeNumber("depositWaitMs", o.depositWaitMs, 0);
}

function openLedger(path: string | undefined): { ledger: Ledger; state: FacilitatorState } {
  try {
    const ledger = new Ledger(path);
    const state = new FacilitatorState();
    for (const event of ledger.replay()) state.apply(event);
    return { ledger, state };
  } catch (e) {
    throw new Error(`ledgerPath: cannot replay ${path}: ${text(e)}`, { cause: e });
  }
}

function listen(app: Express, host: string, port: number, log: Log): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    const refuse = (e: NodeJS.ErrnoException): void => {
      reject(new Error(`port: cannot listen on ${host}:${port} (${e.code ?? e.message})`));
    };
    server.once("error", refuse);
    server.listen(port, host, () => {
      server.off("error", refuse);
      server.on("error", (e) => log("http server error", e));
      resolve(server);
    });
  });
}

/** Replays the ledger, polls the chain once, then listens, and a failed poll does not stop the start */
export async function startFacilitator(o: FacilitatorOptions): Promise<FacilitatorHandle> {
  checkOptions(o);
  const host = o.host ?? DEFAULT_HOST;
  const { ledger, state } = openLedger(o.ledgerPath);
  const { onFatal } = o;

  // The first failed write is the only one reported, since the host exits on it
  let fired = false;
  const fatal = (err: unknown): void => {
    if (fired) return;
    fired = true;
    onFatal?.(err);
  };
  // A watcher pass already in flight when close() runs must not write once it resumes
  let closed = false;

  const write = (events: LedgerEvent[]): void => commit(ledger, state, events);
  const resolver = new DepositResolver({ chain: o.chain });
  const watcher = new ChainWatcher({
    chain: o.chain,
    state,
    // The scheme reports its own failed writes to fatal, so the watcher's writes are the ones reported here
    commit: (events) => {
      if (closed) return;
      try {
        write(events);
      } catch (err) {
        fatal(err);
        throw err;
      }
    },
    intervalMs: o.pollIntervalMs ?? DEFAULT_POLL_MS,
    log: o.log,
  });
  const scheme = new PrepaidVoucherFacilitatorScheme({
    config: {
      network: o.network,
      payTo: o.payTo,
      priceZat: o.priceZat,
      terms: o.terms,
      depositWaitMs: o.depositWaitMs ?? DEFAULT_DEPOSIT_WAIT_MS,
    },
    state,
    resolver,
    watcher,
    commit: write,
    onFatal: fatal,
    log: o.log,
  });
  const facilitator = new x402Facilitator().register(o.network, scheme);

  await watcher.pollNow();
  const server = await listen(
    createFacilitatorApp({ facilitator, authToken: o.authToken, log: o.log }),
    host,
    o.port ?? 0,
    o.log ?? stderr,
  );
  watcher.start();

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    pollNow: () => (closed ? Promise.resolve() : watcher.pollNow()),
    close: () => {
      closed = true;
      return (closing ??= new Promise<void>((resolve, reject) => {
        watcher.stop();
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        server.closeIdleConnections();
      }));
    },
  };
}
