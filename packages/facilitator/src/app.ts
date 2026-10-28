/**
 * The facilitator's HTTP face and its start-up (design §3 and §4.1 to §4.5, protocol.md §7.1).
 *
 * A bearer key picks the provider, and that provider's runtime answers with a scheme that refuses any other payTo.
 * POST /verify and /settle answer HTTP 200 whatever happens, since a 500 leaks its body into the client's error and a
 * 4xx has no place in the schema. Only a key that names no provider (401) and an unknown route (404) are not 200.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { Catalog } from "./discovery/catalog.js";
import { mountBazaar } from "./discovery/routes.js";
import { keyDigest } from "./providers/apiKey.js";
import { providerId } from "./providers/id.js";
import { createRegistrar, RegistrationRefused, type Registrar } from "./providers/register.js";
import { openRegistry, type ProviderEntry, type ProviderRegistry } from "./providers/registry.js";
import { openRuntime, type Log, type ProviderRuntime } from "./runtime.js";

const stderr: Log = (msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err));

export interface ProvidersOptions {
  /** Where the registry and the ledgers of the registered providers live, made with mode 0700 */
  dir: string;
  /** The chain view that reads the deposits to `payTo` with the viewing key `uivk` */
  chainFor(p: { payTo: string; uivk: string }): ChainView;
  /** Whether `uivk` is the viewing key of `payTo` and `payTo` takes no transparent deposit */
  owns(p: { payTo: string; uivk: string }): Promise<boolean>;
  /** The most providers that can register, the operator not counted, default 32 */
  max?: number;
  /** Bearer token that POST /providers requires, and left out means anyone may register */
  registrationToken?: string;
  /** False refuses POST /providers as registration_disabled, and registered providers keep serving, default true */
  registrationEnabled?: boolean;
}

export interface FacilitatorOptions {
  network: ZcashNetwork;
  chain: ChainView;
  payTo: string;
  /** Ignored since protocol v2.0, each provider prices its own routes */
  priceZat?: bigint;
  terms: Terms;
  /** Bearer token of the operator's provider, and without one a request with no header is the operator's */
  authToken?: string;
  /** JSON Lines ledger replayed at start, left out means an in-memory ledger and no file I/O */
  ledgerPath?: string;
  /** Providers that register themselves, left out means POST /providers is refused as registration_disabled */
  providers?: ProvidersOptions;
  /** Default 127.0.0.1 */
  host?: string;
  /** Default 0 picks a free port, read the real one from url */
  port?: number;
  /** Default 5000 */
  pollIntervalMs?: number;
  /** How long verify waits for a deposit the chain does not show yet, default 30000 */
  depositWaitMs?: number;
  /** Called once, on the first failed ledger write or once a ledger lock names another start, so the host exits */
  onFatal?: (err: unknown) => void;
  /** Receives one line per request (method, path, status, reason, provider) and the diagnostics, default stderr */
  log?: Log;
}

export interface FacilitatorHandle {
  url: string;
  /** One best effort pass over every live deposit of every provider, which does nothing once closed */
  pollNow(): Promise<void>;
  /** How many providers are registered, the operator not counted */
  providerCount(): number;
  /** Stops the watchers and the server, and a watcher pass still in flight does not write to a ledger */
  close(): Promise<void>;
}

/** What a route needs of the provider whose key it was given */
export type Tenant = Pick<ProviderRuntime, "id" | "network" | "payTo" | "facilitator" | "extra">;

export interface AppOptions {
  /** The operator's provider, whose facilitator answers GET /supported */
  operator: Tenant;
  /** The provider an Authorization header belongs to, undefined when it belongs to none or there is no header */
  tenantOf(authorization: string | undefined): Tenant | undefined;
  /** Registers the provider a POST /providers asks for, and without it every such request is registration_disabled */
  register?: Registrar;
  /** Bearer token that POST /providers requires, and left out means anyone may call it */
  registrationToken?: string;
  /** False refuses every POST /providers as registration_disabled, unread and with no token asked, default true */
  registrationEnabled?: boolean;
  /** The Bazaar's catalog, and without one there are no discovery routes */
  catalog?: Catalog;
  log?: Log;
}

interface Refusal {
  code: ReasonCode;
  message: string;
}

type Read = { ok: true; payload: PaymentPayload; requirements: PaymentRequirements } | { ok: false; refusal: Refusal };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_PROVIDERS = 32;
const MAX_PROVIDERS_LIMIT = 1000;
const BODY_LIMIT = "64kb";
const MAX_LOGGED_PATH = 120;
/** CAIP-2 ids are at most 41 characters, so anything longer is not worth echoing back */
const MAX_NETWORK_LENGTH = 64;
/** One or more spaces after the scheme, as RFC 7235 allows */
const BEARER = /^bearer +(.+)$/i;
/** An RFC 6750 b64token, the only token an Authorization header can carry and match */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const NO_TOKEN = "leave it out to run without a token";
const OPEN_REGISTRATION = "leave it out to let anyone register";
const NO_PROVIDERS_DIRECTORY = "this facilitator has no providers directory";
const REGISTRATION_CLOSED = "registration is closed on this facilitator";
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
        // A request that carried a provider's key names that provider, and never the key
        const provider = typeof res.locals.provider === "string" ? ` ${res.locals.provider}` : "";
        // A logger that throws must not take the process down from an event handler
        try {
          log(`${req.method} ${shown} ${res.statusCode}${reason}${provider}`);
        } catch {}
      });
    }
    next();
  };
}

function refuse(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function unauthorized(res: Response): void {
  res.set("WWW-Authenticate", "Bearer");
  res.status(401).json({ error: "unauthorized" });
}

/** Finds the provider of the request, or refuses it with 401 and a challenge */
function tenancy(tenantOf: AppOptions["tenantOf"]): RequestHandler {
  return (req, res, next) => {
    const tenant = tenantOf(req.get("authorization"));
    if (tenant === undefined) {
      unauthorized(res);
      return;
    }
    res.locals.tenant = tenant;
    res.locals.provider = tenant.id;
    next();
  };
}

/** For a route that needs no key, which lets a request with none by and refuses one whose key names no provider */
function noStrangers(tenantOf: AppOptions["tenantOf"]): RequestHandler {
  return (req, res, next) => {
    const authorization = req.get("authorization");
    if (authorization === undefined || tenantOf(authorization) !== undefined) next();
    else unauthorized(res);
  };
}

/** The provider that `tenancy` found for this request */
const providerOf = (res: Response): Tenant => res.locals.tenant as Tenant;

/** Lets a request through when no registration token is set or it carries that token */
function registrationGate(token: string | undefined): RequestHandler {
  const expected = token === undefined ? undefined : digest(token);
  return (req, res, next) => {
    const header = req.get("authorization");
    const presented = header === undefined ? undefined : BEARER.exec(header)?.[1];
    // Both sides are hashed first, so the comparison takes the same time whatever the lengths
    if (expected === undefined || (presented !== undefined && timingSafeEqual(digest(presented), expected))) {
      next();
      return;
    }
    res.set("WWW-Authenticate", "Bearer");
    refuse(res, 401, "unauthorized", "registration needs the registration token as a bearer token");
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

export function createFacilitatorApp(o: AppOptions): Express {
  const { operator, tenantOf, register, registrationToken, registrationEnabled, log } = o;
  checkToken("providers.registrationToken", registrationToken, OPEN_REGISTRATION);
  const diagnose = log ?? stderr;

  /** The network a failed settle names when the request gave no usable one, which is the one registered here */
  const networkOf = (body: unknown, tenant: Tenant): Network => {
    const requirements = isRecord(body) ? body.paymentRequirements : undefined;
    const sent = isRecord(requirements) ? requirements.network : undefined;
    return (typeof sent === "string" && sent.length <= MAX_NETWORK_LENGTH ? sent : tenant.network) as Network;
  };

  async function verify(tenant: Tenant, read: Read): Promise<VerifyResponse> {
    if (!read.ok) return verifyRefused(read.refusal);
    try {
      return await tenant.facilitator.verify(read.payload, read.requirements);
    } catch (e) {
      if (isUnregistered(e)) return verifyRefused(UNSUPPORTED);
      diagnose("verify failed unexpectedly", e);
      return verifyRefused(UNEXPECTED_VERIFY);
    }
  }

  async function settle(tenant: Tenant, read: Read, network: Network): Promise<SettleResponse> {
    if (!read.ok) return settleRefused(read.refusal, network);
    try {
      return await tenant.facilitator.settle(read.payload, read.requirements);
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

  /* Public routes */

  // Needs no key, yet a key that is presented must be one of ours, so a wrong one is found out at start as before
  app.get("/supported", noStrangers(tenantOf), (_req: Request, res: Response) => {
    res.json(operator.facilitator.getSupported());
  });

  if (register === undefined || registrationEnabled === false) {
    app.post("/providers", (_req: Request, res: Response) => {
      refuse(res, 403, "registration_disabled", register === undefined ? NO_PROVIDERS_DIRECTORY : REGISTRATION_CLOSED);
    });
  } else {
    app.post("/providers", registrationGate(registrationToken), jsonBody(), async (req: Request, res: Response) => {
      try {
        const unreadable: unknown = res.locals.unreadable;
        if (typeof unreadable === "string") throw new RegistrationRefused(400, "invalid_request", unreadable);
        const done = await register(req.body);
        // The answer carries the key, which is shown once
        res.set("Cache-Control", "no-store");
        res.status(done.status).json(done.body);
      } catch (e) {
        if (!(e instanceof RegistrationRefused)) throw e;
        // A failure of ours says no more than any other 500 does
        if (e.status === 500) res.status(500).json({ error: e.code });
        else refuse(res, e.status, e.code, e.message);
      }
    });
  }

  /* Routes behind a provider's key, which find the provider with providerOf(res) */

  const authenticated = tenancy(tenantOf);

  // A resource server reads this at start to prove that its key and its payTo belong together (design §4.1)
  app.get("/providers/me", authenticated, (_req: Request, res: Response) => {
    const { id, network, payTo } = providerOf(res);
    res.json({ providerId: id, network, payTo });
  });

  /* The Bazaar, whose routes are in discovery/routes.ts behind the same keys */

  const { catalog } = o;
  const bazaar =
    catalog &&
    mountBazaar(app, {
      catalog,
      authenticated,
      open: noStrangers(tenantOf),
      jsonBody: jsonBody(),
      providerOf,
      log: diagnose,
    });

  app.post("/verify", authenticated, jsonBody(), async (req: Request, res: Response) => {
    const result = await verify(providerOf(res), readRequest(req.body, res.locals.unreadable));
    res.locals.reason = result.invalidReason;
    res.json(result);
  });

  app.post("/settle", authenticated, jsonBody(), async (req: Request, res: Response) => {
    const tenant = providerOf(res);
    const result = await settle(tenant, readRequest(req.body, res.locals.unreadable), networkOf(req.body, tenant));
    res.locals.reason = result.errorReason;
    // The catalog hears of a payment that settled, before the answer goes and without changing it
    if (result.success) bazaar?.settled(tenant, req.body);
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

function checkToken(name: string, token: string | undefined, leaveOut: string): void {
  if (token === undefined) return;
  if (token === "") throw new Error(`${name}: must not be empty (${leaveOut})`);
  if (typeof token !== "string" || !B64TOKEN.test(token)) {
    throw new Error(`${name}: must be one token of letters, digits and -._~+/ (no spaces or control characters)`);
  }
}

const isBlank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

function checkProviders(p: ProvidersOptions | undefined): void {
  if (p === undefined) return;
  if (isBlank(p.dir)) throw new Error("providers.dir: must not be blank (leave providers out to refuse registration)");
  if (typeof p.chainFor !== "function") throw new Error("providers.chainFor: must be a function");
  if (typeof p.owns !== "function") throw new Error("providers.owns: must be a function");
  wholeNumber("providers.max", p.max, 0, MAX_PROVIDERS_LIMIT);
  checkToken("providers.registrationToken", p.registrationToken, OPEN_REGISTRATION);
  if (p.registrationEnabled !== undefined && typeof p.registrationEnabled !== "boolean") {
    throw new Error("providers.registrationEnabled: must be true or false");
  }
}

/** Refuses a bad option before anything is opened, naming the field */
function checkOptions(o: FacilitatorOptions): void {
  if (!isZcashNetwork(o.network)) throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
  if (!isValidPayTo(o.payTo, o.network)) throw new Error(`payTo: not a shielded-only unified address for ${o.network}`);
  try {
    parseTerms(encodeTerms(o.terms));
  } catch (e) {
    throw new Error(`terms: ${text(e)}`);
  }
  checkToken("authToken", o.authToken, NO_TOKEN);
  wholeNumber("port", o.port, 0, 65535);
  wholeNumber("pollIntervalMs", o.pollIntervalMs, 1, MAX_TIMER_MS);
  wholeNumber("depositWaitMs", o.depositWaitMs, 0, MAX_DEPOSIT_WAIT_MS);
  if (o.host !== undefined && isBlank(o.host)) throw new Error("host: must not be blank");
  if (o.ledgerPath !== undefined && isBlank(o.ledgerPath)) {
    throw new Error("ledgerPath: must not be blank (leave it out for an in-memory ledger)");
  }
  checkProviders(o.providers);
}

/** Refuses a registry that a registration could not have written, before any provider is opened or asked about */
function checkEntries(
  o: FacilitatorOptions,
  entries: readonly ProviderEntry[],
  keys: ReadonlyMap<string, unknown>,
): void {
  const hashes = new Set(keys.keys());
  for (const entry of entries) {
    if (entry.id !== providerId(o.network, entry.payTo)) {
      throw new Error(`providersDir: registry entry ${entry.id} does not match its payTo`);
    }
    if (entry.payTo === o.payTo) throw new Error(`providersDir: registry entry ${entry.id} has the operator's payTo`);
    if (hashes.has(entry.keyHash)) {
      throw new Error(`providersDir: registry entry ${entry.id} shares its API key with another provider`);
    }
    hashes.add(entry.keyHash);
  }
}

/** Asks about every entry at once, and refuses the start for the first in registry order that fails */
async function checkOwnership(providers: ProvidersOptions, entries: readonly ProviderEntry[]): Promise<void> {
  const answers = await Promise.allSettled(entries.map((e) => providers.owns({ payTo: e.payTo, uivk: e.uivk })));
  for (const [i, answer] of answers.entries()) {
    const id = entries[i]?.id;
    if (answer.status === "rejected") {
      const why = text(answer.reason);
      throw new Error(`providersDir: provider ${id}: cannot check that the stored viewing key owns its payTo (${why})`);
    }
    if (!answer.value) {
      throw new Error(`providersDir: provider ${id}: the stored viewing key no longer owns its payTo`);
    }
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

/** Opens every runtime and polls each once, then listens and starts the watchers, and a failed poll does not stop it */
export async function startFacilitator(o: FacilitatorOptions): Promise<FacilitatorHandle> {
  checkOptions(o);
  const fatal = once(o.onFatal);
  const diagnose = o.log ?? stderr;
  const host = o.host ?? DEFAULT_HOST;
  const providers = o.providers;

  // The operator first, then the registered providers in the order they registered
  const runtimes: ProviderRuntime[] = [];
  const keys = new Map<string, ProviderRuntime>();
  const byPayTo = new Map<string, ProviderRuntime>();
  let registry: ProviderRegistry | undefined;

  const open = (payTo: string, chain: ChainView, ledgerPath?: string): Promise<ProviderRuntime> =>
    openRuntime({
      network: o.network,
      payTo,
      chain,
      terms: o.terms,
      ledgerPath,
      depositWaitMs: o.depositWaitMs,
      pollIntervalMs: o.pollIntervalMs,
      onFatal: fatal,
      log: o.log,
    });

  // A runtime stopped twice or released twice does nothing the second time
  const releaseAll = (): void => {
    for (const runtime of runtimes) {
      runtime.stop();
      runtime.release();
    }
    registry?.close();
  };

  let operator: ProviderRuntime;
  let server: Server;
  let register: Registrar | undefined;
  let catalog: Catalog;
  try {
    operator = await open(o.payTo, o.chain, o.ledgerPath);
    runtimes.push(operator);
    if (o.authToken !== undefined) keys.set(keyDigest(o.authToken), operator);

    if (providers !== undefined) {
      registry = await openRegistry({ dir: providers.dir, network: o.network, onLost: fatal });
      const entries = registry.entries();
      checkEntries(o, entries, keys);
      await checkOwnership(providers, entries);

      const ledgers = registry;
      const opened = await Promise.allSettled(
        entries.map(async (entry) => {
          const chain = providers.chainFor({ payTo: entry.payTo, uivk: entry.uivk });
          return { entry, runtime: await open(entry.payTo, chain, ledgers.ledgerPath(entry.id)) };
        }),
      );
      // Every runtime that opened is kept, so that a failure of another lets them go
      for (const result of opened) {
        if (result.status !== "fulfilled") continue;
        runtimes.push(result.value.runtime);
        byPayTo.set(result.value.entry.payTo, result.value.runtime);
        keys.set(result.value.entry.keyHash, result.value.runtime);
      }
      const failed = opened.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;

      register = createRegistrar({
        network: o.network,
        operatorPayTo: o.payTo,
        registry,
        max: providers.max ?? DEFAULT_MAX_PROVIDERS,
        owns: providers.owns,
        open: (p) => open(p.payTo, providers.chainFor({ payTo: p.payTo, uivk: p.uivk }), p.ledgerPath),
        runtimeOf: (payTo) => byPayTo.get(payTo),
        admit: (runtime, keyHash) => {
          runtimes.push(runtime);
          byPayTo.set(runtime.payTo, runtime);
          keys.set(keyHash, runtime);
        },
        rekey: (runtime, keyHash, replacing) => {
          keys.delete(replacing);
          keys.set(keyHash, runtime);
        },
        log: diagnose,
      });
    }

    await Promise.all(runtimes.map((runtime) => runtime.pollNow()));
    // Its file is in the providers directory under the registry lock, and without one it is memory only
    catalog = Catalog.load({ file: registry?.catalogPath(), log: diagnose });
    const tenantOf = (authorization: string | undefined): Tenant | undefined => {
      // Without a token the operator serves a request that carries no header, and never one that carries a bad key
      if (authorization === undefined) return o.authToken === undefined ? operator : undefined;
      const presented = BEARER.exec(authorization)?.[1];
      return presented === undefined ? undefined : keys.get(keyDigest(presented));
    };
    const app = createFacilitatorApp({
      operator,
      tenantOf,
      register,
      registrationToken: providers?.registrationToken,
      registrationEnabled: providers?.registrationEnabled,
      catalog,
      log: o.log,
    });
    server = await listen(app, host, o.port ?? 0, diagnose);
  } catch (e) {
    releaseAll();
    throw e;
  }
  for (const runtime of runtimes) runtime.start();

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    pollNow: async () => {
      await Promise.all(runtimes.map((runtime) => runtime.pollNow()));
    },
    providerCount: () => registry?.entries().length ?? 0,
    close: () => {
      for (const runtime of runtimes) runtime.stop();
      // Everything is freed only once the requests in flight have ended, since a settle among them still writes
      return (closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        server.closeIdleConnections();
      }).finally(async () => {
        // The catalog is written last of all, while the registry lock that covers its file is still held
        try {
          await catalog.close();
        } finally {
          releaseAll();
        }
      }));
    },
  };
}
