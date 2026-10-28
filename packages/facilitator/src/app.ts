/**
 * The facilitator's HTTP face and its start-up (design §3 and §4.3 to §4.5, protocol.md §7.1).
 *
 * POST /verify and /settle answer HTTP 200 whatever happens, since a 500 leaks its body into the client's error and a
 * 4xx has no place in the schema. Only a missing or wrong token (401) and an unknown route (404) are not 200.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
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
import {
  checkLedgerHeader,
  Ledger,
  LedgerMismatch,
  LedgerRefusal,
  type LedgerEvent,
  type LedgerOwner,
} from "./core/ledger.js";
import { lockLedger } from "./core/ledgerLock.js";
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
  /** Called once, on the first failed ledger write or once the ledger lock names another start, so the host exits */
  onFatal?: (err: unknown) => void;
  /** Receives one line per request (method, path, status, reason code) and the diagnostics, which default to stderr */
  log?: Log;
}

export interface FacilitatorHandle {
  url: string;
  /** One best effort pass over every live deposit, which does nothing once closed */
  pollNow(): Promise<void>;
  /** Stops the watcher and the server, and a watcher pass still in flight does not write to the ledger */
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
/** One or more spaces after the scheme, as RFC 7235 allows */
const BEARER = /^bearer +(.+)$/i;
/** An RFC 6750 b64token, the only token an Authorization header can carry and match */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const EMPTY_TOKEN = "authToken: must not be empty (leave it out to run without a token)";
const BAD_TOKEN = "authToken: must be one token of letters, digits and -._~+/ (no spaces or control characters)";
/** The longest delay setInterval honours, past which Node fires it after 1 ms */
const MAX_TIMER_MS = 2_147_483_647;
/** The scheme's own ceiling, the wait the API's 60 s for a verify was sized for */
const MAX_DEPOSIT_WAIT_MS = 30_000;

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
  checkToken(authToken);
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

function checkToken(token: string | undefined): void {
  if (token === undefined) return;
  if (token === "") throw new Error(EMPTY_TOKEN);
  if (typeof token !== "string" || !B64TOKEN.test(token)) throw new Error(BAD_TOKEN);
}

const isBlank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

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
  checkToken(o.authToken);
  wholeNumber("port", o.port, 0, 65535);
  wholeNumber("pollIntervalMs", o.pollIntervalMs, 1, MAX_TIMER_MS);
  wholeNumber("depositWaitMs", o.depositWaitMs, 0, MAX_DEPOSIT_WAIT_MS);
  if (o.host !== undefined && isBlank(o.host)) throw new Error("host: must not be blank");
  if (o.ledgerPath !== undefined && isBlank(o.ledgerPath)) {
    throw new Error("ledgerPath: must not be blank (leave it out for an in-memory ledger)");
  }
}

interface OpenLedger {
  ledger: Ledger;
  state: FacilitatorState;
  /** Frees the ledger file for the next facilitator, and does nothing the second time */
  release: () => void;
}

/** Locks the file, proves it can be written, then replays it, so a facilitator that says ready can record a settle */
async function openLedger(path: string | undefined, own: LedgerOwner, fatal: Fatal): Promise<OpenLedger> {
  if (path === undefined) return { ledger: new Ledger(), state: new FacilitatorState(), release: () => undefined };
  const lock = await lockLedger(path, { onLost: fatal });
  try {
    writable(path);
    return { ...replayed(path, own, lock.assertHeld), release: lock.release };
  } catch (e) {
    lock.release();
    throw e;
  }
}

function writable(path: string): void {
  try {
    closeSync(openSync(path, "a", 0o600));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EISDIR" || code === "EROFS") {
      throw new Error(`ledgerPath: ${path} is not writable (${code})`, { cause: e });
    }
    throw new Error(`ledgerPath: cannot open ${path} (${code ?? text(e)})`, { cause: e });
  }
}

/** Replays the ledger of `own`, and gives a ledger with no events the header that names its facilitator */
function replayed(path: string, own: LedgerOwner, guard: () => void): { ledger: Ledger; state: FacilitatorState } {
  try {
    // Every write first checks that the lock is still this facilitator's
    const ledger = new Ledger(path, { guard });
    const state = new FacilitatorState();
    let first = true;
    // Each event is applied as it is read, so a long ledger is never held whole
    for (const event of ledger.events()) {
      if (first) checkLedgerHeader(event, own, path);
      const header = first && event.t === "ledger";
      first = false;
      if (!header) state.apply(event);
    }
    if (first) ledger.appendSync([{ t: "ledger", network: own.network, payTo: own.payTo }]);
    return { ledger, state };
  } catch (e) {
    if (e instanceof LedgerMismatch) throw e;
    throw new Error(`ledgerPath: cannot replay ${path}: ${text(e)}`, { cause: e });
  }
}

function listen(app: Express, host: string, port: number, log: Log): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    const refuse = (e: NodeJS.ErrnoException): void => {
      const field = e.code === "EADDRINUSE" || e.code === "EACCES" ? "port" : "host";
      reject(new Error(`${field}: cannot listen on ${host}:${port} (${e.code ?? e.message})`));
    };
    server.once("error", refuse);
    server.listen(port, host, () => {
      server.off("error", refuse);
      server.on("error", (e) => log("http server error", e));
      resolve(server);
    });
  });
}

/** Opens the ledger, polls the chain once, then listens, and a failed poll does not stop the start */
export async function startFacilitator(o: FacilitatorOptions): Promise<FacilitatorHandle> {
  checkOptions(o);
  const fatal = once(o.onFatal);
  const opened = await openLedger(o.ledgerPath, { network: o.network, payTo: o.payTo }, fatal);
  try {
    return await serve(o, opened, fatal);
  } catch (e) {
    opened.release();
    throw e;
  }
}

type Fatal = (err: unknown) => void;

/** The first failure is the only one reported, since the host exits on it */
function once(onFatal: Fatal | undefined): Fatal {
  let fired = false;
  return (err) => {
    if (fired) return;
    fired = true;
    onFatal?.(err);
  };
}

async function serve(
  o: FacilitatorOptions,
  { ledger, state, release }: OpenLedger,
  fatal: Fatal,
): Promise<FacilitatorHandle> {
  const host = o.host ?? DEFAULT_HOST;
  // A watcher pass already in flight when close() runs must not write once it resumes
  let closed = false;

  // Not gated on closed, since a settle in flight must still be recorded and the server closes before it ends
  const write = (events: LedgerEvent[]): void => commit(ledger, state, events);
  const resolver = new DepositResolver({ chain: o.chain, log: o.log });
  const watcher = new ChainWatcher({
    chain: o.chain,
    state,
    // The scheme reports its own failed writes, and a refused batch wrote nothing, so only these failures are fatal
    commit: (events) => {
      if (closed) return;
      try {
        write(events);
      } catch (err) {
        if (!(err instanceof LedgerRefusal)) fatal(err);
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
      // The ledger is freed only once the requests in flight have ended, since a settle among them still writes
      return (closing ??= new Promise<void>((resolve, reject) => {
        watcher.stop();
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        server.closeIdleConnections();
      }).finally(release));
    },
  };
}
