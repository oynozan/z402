/**
 * The merchant's paid HTTP API (design §4.6, protocol.md v2.0 §15). One route, `/chunk`, priced in zatoshi and paid
 * with prepaid-voucher through the stock x402 Express middleware, which has the facilitator verify each voucher
 * before the handler runs and settle it after. The terms come from the facilitator's /supported at start. Given a
 * public URL, the API also declares its route to the facilitator's Bazaar every 30 s (declare.ts), which lists the
 * route before its first sale and tells that the API is up.
 *
 * Every startup failure names the option at fault, so the message tells the operator which setting to fix.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  FacilitatorCapabilityError,
  HTTPFacilitatorClient,
  RouteConfigurationError,
  x402HTTPResourceServer,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  ASSET,
  isValidPayTo,
  isZcashNetwork,
  NETWORK_REGTEST,
  parseZat,
  SCHEME,
  ZCASH_NETWORKS,
  type ZcashNetwork,
} from "@z402/protocol";
import { checkProvider, PrepaidVoucherServerScheme, ProviderCheckError } from "@z402/server";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import {
  CHUNK_PATH,
  DECLARE_INTERVAL_MS,
  declaredResource,
  publicUrlProblem,
  serviceNameProblem,
  startDeclaring,
} from "./declare.js";

export interface ApiOptions {
  network: ZcashNetwork;
  /** Required, since the SDK sends payments to x402.org when it is empty */
  facilitatorUrl: string;
  /** Bearer token for the facilitator, nothing is sent when it is left out */
  facilitatorToken?: string;
  payTo: string;
  priceZat: bigint;
  /** Default 127.0.0.1 */
  host?: string;
  /** Default 0 picks a free port, read the real one from url */
  port?: number;
  /** Where this API is reached, which the 402 names as the route's resource and the Bazaar lists it under */
  publicUrl?: string;
  /** The name the catalog shows for this API, default Demo API, such as Partner API for a second provider */
  serviceName?: string;
  /** How often the route is declared to the Bazaar, default 30000, and only a publicUrl makes the API declare */
  declareIntervalMs?: number;
  /** Where the outcomes of the declarations are reported, default stderr */
  log?: (message: string) => void;
}

export interface ApiHandle {
  url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
/** Covers verify's worst case, the 30 s deposit wait, the inspect and tip that end it, and the 5 s refresh bound */
const FACILITATOR_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_SECONDS = 60;
/** How the Bazaar and the website's catalog name the route: its service, category, line and unit of sale */
const SERVICE_NAME = "Demo API";
const SERVICE_TAGS = ["demo"];
const CHUNK_DESCRIPTION = "One numbered chunk of demo data per paid call";
const CHUNK_UNIT = "chunk";
const X402_VERSION = 2;
const MAX_CAUSES = 5;
/** The longest delay setTimeout honours, past which Node fires it after 1 ms */
const MAX_TIMER_MS = 2_147_483_647;
/** An RFC 6750 b64token, the only token an Authorization header can carry and match */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** localhost, 127.0.0.0/8 or [::1], as a URL spells the host */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** Refuses a bad option before the facilitator is contacted, naming the field and never quoting its value */
function checkOptions(o: ApiOptions): void {
  const url = o.facilitatorUrl;
  const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined;
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("facilitatorUrl: expected an http:// or https:// URL (an empty one would fall back to x402.org)");
  }
  // Every startup error names the facilitator by its URL, so a password in it would be printed
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("facilitatorUrl: must not carry credentials (use facilitatorToken)");
  }
  const token = o.facilitatorToken;
  if (token === "") throw new Error("facilitatorToken: must not be empty (leave it out to send none)");
  if (token !== undefined && (typeof token !== "string" || !B64TOKEN.test(token))) {
    throw new Error("facilitatorToken: must be one token of letters, digits and -._~+/");
  }
  if (!isZcashNetwork(o.network)) throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
  // The bearer token and every voucher cross this link, and regtest keeps plaintext for a compose network's hosts
  if (parsed.protocol === "http:" && o.network !== NETWORK_REGTEST && !isLoopback(parsed.hostname)) {
    throw new Error(
      `facilitatorUrl: plaintext http:// is allowed only to a loopback host on ${o.network}; use https://`,
    );
  }
  if (!isValidPayTo(o.payTo, o.network)) throw new Error(`payTo: not a shielded-only unified address for ${o.network}`);
  // initialize() never prices the route, so a bad price would otherwise fail every request instead of the start
  if (typeof o.priceZat !== "bigint" || o.priceZat < 1n) throw new Error("priceZat: must be a bigint of at least 1 zat");
  const problem = o.publicUrl === undefined ? undefined : publicUrlProblem(o.publicUrl);
  if (problem !== undefined) throw new Error(`publicUrl: ${problem}`);
  const unnamed = o.serviceName === undefined ? undefined : serviceNameProblem(o.serviceName);
  if (unnamed !== undefined) throw new Error(`serviceName: ${unnamed}`);
  const every = o.declareIntervalMs;
  if (every !== undefined && (!Number.isInteger(every) || every < 1 || every > MAX_TIMER_MS)) {
    throw new Error(`declareIntervalMs: expected a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`);
  }
}

function checkListen(o: ApiOptions): void {
  if (o.host !== undefined && (typeof o.host !== "string" || o.host.trim() === "")) {
    throw new Error("host: must not be blank");
  }
  if (o.port !== undefined && (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535)) {
    throw new Error("port: expected a whole number from 0 to 65535");
  }
}

function facilitatorClient(o: ApiOptions): HTTPFacilitatorClient {
  const token = o.facilitatorToken;
  return new HTTPFacilitatorClient({
    url: o.facilitatorUrl,
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

/** Refuses to start unless the facilitator knows this key as the provider paid at this payTo */
async function checkKey(o: ApiOptions): Promise<void> {
  try {
    await checkProvider({
      facilitatorUrl: o.facilitatorUrl,
      token: o.facilitatorToken,
      payTo: o.payTo,
      network: o.network,
    });
  } catch (e) {
    // A retryable error fails the start too, since the API has no wait of its own
    if (e instanceof ProviderCheckError) throw new Error(e.message, { cause: e });
    throw e;
  }
}

/** Names the option an initialize() failure points at, keeping the SDK's error as the cause */
function startupError(e: unknown, server: x402ResourceServer, o: ApiOptions): Error {
  const at = `the facilitator at ${o.facilitatorUrl}`;
  if (e instanceof FacilitatorCapabilityError) {
    return new Error(`facilitatorUrl: ${at} advertises terms this API cannot use (${e.problems.join("; ")})`, {
      cause: e,
    });
  }
  if (e instanceof RouteConfigurationError) {
    const offered = ZCASH_NETWORKS.filter((n) => server.getSupportedKind(X402_VERSION, n, SCHEME) !== undefined);
    const where = offered.length > 0 ? offered.join(", ") : "no Zcash network";
    return new Error(`network: ${at} offers ${SCHEME} on ${where}, not on ${o.network}`, { cause: e });
  }
  const reason = causes(e);
  if (/\((401|403)\)/.test(reason)) {
    return new Error(`facilitatorToken: ${at} refused the request (${reason})`, { cause: e });
  }
  return new Error(`facilitatorUrl: cannot read /supported from ${at} (${reason})`, { cause: e });
}

/** What GET /chunk declares to the Bazaar, in the shape declareDiscoveryExtension makes for a GET with no input */
function bazaarExtension(priceZat: bigint) {
  return {
    info: {
      input: { type: "http", method: "GET" },
      output: { type: "json", example: { chunk: 1, cumulativeZat: priceZat.toString(), data: "chunk-1" } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET"] },
            queryParams: { type: "object", properties: {} },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: { type: "object" } },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

/** The chunk is the paid voucher's cumulative over the price, so the handler keeps no state of its own */
function chunk(priceZat: bigint): RequestHandler {
  return (req: Request, res: Response) => {
    // The middleware runs this only once the facilitator has verified the voucher in this header
    const { payload } = decodePaymentSignatureHeader(req.header("payment-signature") ?? "");
    const cumulativeZat = parseZat(payload.cumulativeZat as string);
    const n = Number(cumulativeZat / priceZat);
    res.json({ chunk: n, cumulativeZat: cumulativeZat.toString(), data: `chunk-${n}` });
  };
}

/** The Express app with the paid route and the x402 server behind it, once /supported has been loaded and checked */
async function buildApi(o: ApiOptions): Promise<{ app: Express; http: x402HTTPResourceServer }> {
  checkOptions(o);
  // Before the first /supported, so a refused key or another payTo is named for what it is
  await checkKey(o);
  // One payTo and one network feed both the scheme and the route, since nothing compares the two later
  const { network, payTo, priceZat, publicUrl, serviceName = SERVICE_NAME } = o;
  const server = new x402ResourceServer(facilitatorClient(o)).register(
    network,
    new PrepaidVoucherServerScheme({ payTo, network }),
  );
  const routes: RoutesConfig = {
    // Keyed without a verb, so a request of any method must pay before it reaches a handler
    [CHUNK_PATH]: {
      accepts: {
        scheme: SCHEME,
        network,
        price: { amount: priceZat.toString(), asset: ASSET },
        payTo,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
      // The 402 names the resource that is declared, so that a settled payment matches its item
      ...(publicUrl !== undefined && { resource: `${publicUrl.replace(/\/+$/, "")}${CHUNK_PATH}` }),
      description: CHUNK_DESCRIPTION,
      mimeType: "application/json",
      // The names and unit the website's catalog shows, in the shape the service kit gives its routes
      serviceName,
      tags: SERVICE_TAGS,
      extensions: { bazaar: bazaarExtension(priceZat), z402: { unit: CHUNK_UNIT } },
    },
  };
  const http = new x402HTTPResourceServer(server, routes);
  try {
    await http.initialize();
  } catch (e) {
    throw startupError(e, server, o);
  }

  const app = express();
  app.disable("x-powered-by");
  // The support is loaded above, and false keeps the middleware from loading it again or exiting the process
  app.use(paymentMiddlewareFromHTTPServer(http, undefined, undefined, false));
  // Registered before the GET route, which Express would otherwise also run for HEAD
  app.head(CHUNK_PATH, notAllowed);
  app.get(CHUNK_PATH, chunk(priceZat));
  app.all(CHUNK_PATH, notAllowed);
  return { app, http };
}

/** The Express app with the paid route, once the facilitator's /supported has been loaded and checked */
export async function createApiApp(o: ApiOptions): Promise<Express> {
  return (await buildApi(o)).app;
}

/** Only GET is served, and the middleware never settles a 405, so the voucher sent with it still buys a GET */
function notAllowed(_req: Request, res: Response): void {
  res.set("Allow", "GET").status(405).json({ error: "method_not_allowed" });
}

function listen(app: Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    const refuse = (e: NodeJS.ErrnoException): void => {
      const field = e.code === "EADDRINUSE" || e.code === "EACCES" ? "port" : "host";
      reject(new Error(`${field}: cannot listen on ${host}:${port} (${e.code ?? e.message})`));
    };
    server.once("error", refuse);
    server.listen(port, host, () => {
      server.off("error", refuse);
      server.on("error", (e) => console.error("api: http server error", e));
      resolve(server);
    });
  });
}

/** Loads the facilitator's support, then listens, and rejects naming the option at fault */
export async function startApi(o: ApiOptions): Promise<ApiHandle> {
  checkListen(o);
  const { app, http } = await buildApi(o);
  // Read before listening, so that a failure here leaves no server to close
  const route = { method: "GET", path: CHUNK_PATH };
  const item = o.publicUrl === undefined ? undefined : await declaredResource(http, route);
  const host = o.host ?? DEFAULT_HOST;
  const server = await listen(app, host, o.port ?? 0);

  const { port } = server.address() as AddressInfo;
  // The first declaration is made at once, now that the route answers
  const declaring =
    item === undefined
      ? undefined
      : startDeclaring({
          facilitatorUrl: o.facilitatorUrl,
          token: o.facilitatorToken,
          item,
          intervalMs: o.declareIntervalMs ?? DECLARE_INTERVAL_MS,
          log: o.log ?? ((message) => console.error(`api: ${message}`)),
        });
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    // close() also drops idle keep-alive connections on Node 19 and later, and waits for requests in flight
    close: () =>
      (closing ??= (async () => {
        await declaring?.stop();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err === undefined ? resolve() : reject(err)));
        });
      })()),
  };
}
