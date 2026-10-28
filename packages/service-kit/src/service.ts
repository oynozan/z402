/**
 * A paid service (design §3.2): its routes are paid with prepaid-voucher through the stock x402 Express middleware,
 * and each one declares itself for Bazaar discovery. The wiring follows apps/api/src/app.ts: one payTo and one network
 * for the scheme and every route, the facilitator's terms loaded and checked before anything listens, and route keys
 * without a verb so that HEAD, which Express hands to the GET handler, must pay too.
 */
import {
  FacilitatorCapabilityError,
  HTTPFacilitatorClient,
  RouteConfigurationError,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RouteConfig,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  isValidServiceName,
  sanitizeTags,
  type DeclareDiscoveryExtensionInput,
} from "@x402/extensions/bazaar";
import { ASSET, SCHEME, ZCASH_NETWORKS } from "@z402/protocol";
import { PrepaidVoucherServerScheme } from "@z402/server";
import express, { type Express, type Request, type RequestHandler } from "express";
import type { ServiceEnv } from "./env.js";
import { CallStats } from "./stats.js";

export type PaidMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface PaidRoute {
  /** The method agents use, which is also the method discovery probes with */
  method: PaidMethod;
  /** Route key without a verb, e.g. "/v1/generate" or "/v1/drops/:id/hold" */
  path: string;
  /** A concrete path for a route with parameters, which discovery probes instead of `path` */
  probePath?: string;
  description: string;
  /** What one call buys, e.g. "output chunk" */
  unit: string;
  /** One short guardrail or privacy note */
  note?: string;
  /** Default "application/json" */
  mimeType?: string;
  discovery: DeclareDiscoveryExtensionInput;
  /**
   * Handlers that run before the payment middleware on this route, e.g. a body parser and the request checks. A
   * refusal here reaches the client on its unpaid first attempt, before any voucher exists. A failure after the voucher
   * is sent is ambiguous to the client, which counts the call, so every check that can run here must.
   */
  prepare?: RequestHandler[];
}

export interface ServiceDefinition {
  /** At most 32 printable ASCII characters */
  serviceName: string;
  tags?: string[];
  routes: PaidRoute[];
}

export interface PaidServiceOptions {
  env: ServiceEnv;
  service: ServiceDefinition;
  /** Whether the service can serve right now, which /health reports. Default always ready */
  ready?: () => boolean | Promise<boolean>;
  /** Handlers mounted before the payment middleware, such as a rate limit that must refuse before anyone pays */
  before?: RequestHandler[];
  /** How long to keep retrying a facilitator that does not answer yet, default env.facilitatorWaitMs or 120000; 0 fails at once */
  facilitatorWaitMs?: number;
  /** Where the retries are reported, default stderr */
  log?: (message: string) => void;
}

export interface PaidService {
  /** Has /health and the payment middleware; the service adds its own handlers after it */
  app: Express;
  stats: CallStats;
  http: x402HTTPResourceServer;
}

/** The z402 extension that rides next to bazaar in every 402 */
export const Z402_EXTENSION = "z402";

/**
 * Discovery probes send this header without a payment, so they skip `prepare` (which would refuse a placeholder id or
 * an empty body) and get the route's 402. A request that carries a payment never skips it.
 */
export const PROBE_HEADER = "x-z402-probe";

function isProbe(req: Request): boolean {
  return (
    req.get(PROBE_HEADER) !== undefined && req.get("payment-signature") === undefined && req.get("x-payment") === undefined
  );
}

const MAX_TIMEOUT_SECONDS = 60;
/** Covers the facilitator's 30 s wait for an unseen deposit, one 5 s chain deadline and the decryption */
const FACILITATOR_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 2_000;
/** How long a readiness answer is reused by the gate in front of the paid routes */
const READY_CACHE_MS = 5_000;
const FACILITATOR_WAIT_MS = 120_000;
const FACILITATOR_RETRY_MS = 2_000;
const X402_VERSION = 2;
const MAX_CAUSES = 5;
const ROUTE_PATH_RE = /^\/[A-Za-z0-9._~:/-]*$/;

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkDefinition(s: ServiceDefinition): void {
  if (!isValidServiceName(s.serviceName)) throw new Error("serviceName: expected 1 to 32 printable ASCII characters");
  if (s.routes.length === 0) throw new Error("routes: a paid service needs at least one route");
  const seen = new Set<string>();
  for (const r of s.routes) {
    if (!ROUTE_PATH_RE.test(r.path) || r.path.includes(" ")) {
      throw new Error(`routes: "${r.path}" must be a path without a verb, starting with /`);
    }
    if (seen.has(r.path)) throw new Error(`routes: "${r.path}" is declared twice`);
    seen.add(r.path);
    if (r.probePath !== undefined && !r.probePath.startsWith("/")) throw new Error(`routes: probePath of ${r.path}`);
    if (r.path.includes(":") && r.probePath === undefined) {
      throw new Error(`routes: "${r.path}" has parameters, so it needs a probePath for discovery`);
    }
    if (r.unit.trim() === "") throw new Error(`routes: "${r.path}" needs a billing unit`);
    if (r.description.trim() === "") throw new Error(`routes: "${r.path}" needs a description`);
  }
}

function facilitatorClient(env: ServiceEnv): HTTPFacilitatorClient {
  const token = env.facilitatorToken;
  return new HTTPFacilitatorClient({
    url: env.facilitatorUrl,
    timeoutMs: FACILITATOR_TIMEOUT_MS,
    ...(token !== undefined && {
      createAuthHeaders: async () => {
        const headers = { Authorization: `Bearer ${token}` };
        return { verify: headers, settle: headers, supported: headers };
      },
    }),
  });
}

/** The messages of the causes under the SDK's own wrapper, outermost first */
function causes(e: unknown): string {
  const parts: string[] = [];
  let current = e instanceof Error ? e.cause : undefined;
  while (current instanceof Error && parts.length < MAX_CAUSES) {
    parts.push(current.message || ((current as NodeJS.ErrnoException).code ?? current.name));
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(": ") : text(e);
}

/** Names the variable an initialize() failure points at, keeping the SDK's error as the cause */
function startupError(e: unknown, server: x402ResourceServer, env: ServiceEnv): Error {
  const at = `the facilitator at ${env.facilitatorUrl}`;
  if (e instanceof FacilitatorCapabilityError) {
    const advertised = server.getSupportedKind(X402_VERSION, env.network, SCHEME)?.extra?.payTo;
    if (advertised !== env.payTo) {
      return new Error(`Z402_PAY_TO: ${at} does not advertise ${env.payTo} as its payTo`, { cause: e });
    }
    return new Error(`Z402_FACILITATOR_URL: ${at} advertises terms this service cannot use (${e.problems.join("; ")})`, {
      cause: e,
    });
  }
  if (e instanceof RouteConfigurationError) {
    const offered = ZCASH_NETWORKS.filter((n) => server.getSupportedKind(X402_VERSION, n, SCHEME) !== undefined);
    const where = offered.length > 0 ? offered.join(", ") : "no Zcash network";
    return new Error(`Z402_NETWORK: ${at} offers ${SCHEME} on ${where}, not on ${env.network}`, { cause: e });
  }
  const reason = causes(e);
  if (/\((401|403)\)/.test(reason)) {
    return new Error(`Z402_FACILITATOR_TOKEN: ${at} refused the request (${reason})`, { cause: e });
  }
  return new Error(`Z402_FACILITATOR_URL: cannot read /supported from ${at} (${reason})`, { cause: e });
}

function routeConfig(env: ServiceEnv, s: ServiceDefinition, r: PaidRoute, tags: string[] | undefined): RouteConfig {
  return {
    accepts: {
      scheme: SCHEME,
      network: env.network,
      price: { amount: env.priceZat.toString(), asset: ASSET },
      payTo: env.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    },
    resource: `${env.publicUrl}${r.path}`,
    description: r.description,
    mimeType: r.mimeType ?? "application/json",
    serviceName: s.serviceName,
    ...(tags !== undefined && { tags }),
    extensions: {
      ...declareDiscoveryExtension(r.discovery),
      [Z402_EXTENSION]: { unit: r.unit, ...(r.note !== undefined && { note: r.note }) },
    },
  };
}

async function readiness(ready: PaidServiceOptions["ready"]): Promise<boolean> {
  if (ready === undefined) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(ready),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Loads the facilitator's terms, then returns the app with /health and the payment middleware mounted */
export async function createPaidService(o: PaidServiceOptions): Promise<PaidService> {
  const { env, service } = o;
  checkDefinition(service);
  const tags = service.tags === undefined ? undefined : sanitizeTags(service.tags);

  const server = new x402ResourceServer(facilitatorClient(env))
    .register(env.network, new PrepaidVoucherServerScheme({ payTo: env.payTo, network: env.network }))
    .registerExtension(bazaarResourceServerExtension);
  const routes: RoutesConfig = Object.fromEntries(service.routes.map((r) => [r.path, routeConfig(env, service, r, tags)]));
  const http = new x402HTTPResourceServer(server, routes);
  // A facilitator that is still starting is waited for, so start order and restarts do not matter
  const log = o.log ?? ((message: string) => console.error(message));
  const deadline = Date.now() + (o.facilitatorWaitMs ?? env.facilitatorWaitMs ?? FACILITATOR_WAIT_MS);
  for (let attempt = 1; ; attempt++) {
    try {
      await http.initialize();
      break;
    } catch (e) {
      const error = startupError(e, server, env);
      const unreachable = error.message.startsWith("Z402_FACILITATOR_URL: cannot read");
      if (!unreachable || Date.now() + FACILITATOR_RETRY_MS > deadline) throw error;
      if (attempt === 1) log(`${error.message}; waiting for it`);
      await new Promise((resolve) => setTimeout(resolve, FACILITATOR_RETRY_MS));
    }
  }

  const stats = new CallStats();
  const app = express();
  app.disable("x-powered-by");

  let cached: { at: number; ready: Promise<boolean> } | undefined;
  const readyNow = (): Promise<boolean> => {
    if (cached === undefined || Date.now() - cached.at > READY_CACHE_MS) {
      cached = { at: Date.now(), ready: readiness(o.ready) };
    }
    return cached.ready;
  };

  app.get("/health", async (_req, res) => {
    const ready = await readyNow();
    res.status(ready ? 200 : 503).json({
      ok: true,
      service: service.serviceName,
      ready,
      network: env.network,
      priceZat: env.priceZat.toString(),
      callsToday: stats.today(),
      routes: service.routes.map((r) => ({
        method: r.method,
        path: r.path,
        ...(r.probePath !== undefined && { probePath: r.probePath }),
        unit: r.unit,
      })),
    });
  });

  // Only a settled call carries PAYMENT-RESPONSE, so this counts paid deliveries and nothing else
  app.use((_req, res, next) => {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && res.getHeader("payment-response") !== undefined) {
        stats.record();
      }
    });
    next();
  });
  for (const handler of o.before ?? []) app.use(handler);

  // Everything that can refuse a paid route without a voucher runs here, so the unpaid first attempt gets the answer
  for (const r of service.routes) {
    app.all(r.path, async (req, res, next) => {
      const allowed = req.method === r.method || (r.method === "GET" && req.method === "HEAD");
      if (!allowed) {
        res.set("Allow", r.method === "GET" ? "GET, HEAD" : r.method);
        res.status(405).json({ error: "method_not_allowed" });
        return;
      }
      if (!(await readyNow())) {
        res.status(503).json({ error: "not_ready" });
        return;
      }
      next();
    });
    for (const handler of r.prepare ?? []) {
      app.all(r.path, (req, res, next) => (isProbe(req) ? next() : handler(req, res, next)));
    }
  }

  // The support is loaded above, and false keeps the middleware from loading it again or exiting the process
  app.use(paymentMiddlewareFromHTTPServer(http, undefined, undefined, false));
  return { app, stats, http };
}
