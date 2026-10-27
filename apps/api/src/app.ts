/**
 * The merchant's paid HTTP API (design §4.6, protocol.md v1.1 §15). One route, `/chunk`, priced in zatoshi and paid
 * with prepaid-voucher through the stock x402 Express middleware, which has the facilitator verify each voucher
 * before the handler runs and settle it after. The terms come from the facilitator's /supported at start.
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
  parseZat,
  SCHEME,
  ZCASH_NETWORKS,
  type ZcashNetwork,
} from "@z402/protocol";
import { PrepaidVoucherServerScheme } from "@z402/server";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";

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
}

export interface ApiHandle {
  url: string;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
/** Covers the facilitator's 30 s wait for an unseen deposit, one 5 s chain deadline and the decryption */
const FACILITATOR_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_SECONDS = 60;
const X402_VERSION = 2;
const MAX_CAUSES = 5;

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Refuses a bad option before the facilitator is contacted, naming the field */
function checkOptions(o: ApiOptions): void {
  const url = o.facilitatorUrl;
  const protocol = typeof url === "string" && URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("facilitatorUrl: expected an http:// or https:// URL (an empty one would fall back to x402.org)");
  }
  if (o.facilitatorToken === "") throw new Error("facilitatorToken: must not be empty (leave it out to send none)");
  if (!isZcashNetwork(o.network)) throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
  if (!isValidPayTo(o.payTo, o.network)) throw new Error(`payTo: not a shielded-only unified address for ${o.network}`);
  // initialize() never prices the route, so a bad price would otherwise fail every request instead of the start
  if (typeof o.priceZat !== "bigint" || o.priceZat < 1n) throw new Error("priceZat: must be a bigint of at least 1 zat");
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

/** Names the option an initialize() failure points at, keeping the SDK's error as the cause */
function startupError(e: unknown, server: x402ResourceServer, o: ApiOptions): Error {
  const at = `the facilitator at ${o.facilitatorUrl}`;
  if (e instanceof FacilitatorCapabilityError) {
    const advertised = server.getSupportedKind(X402_VERSION, o.network, SCHEME)?.extra?.payTo;
    if (advertised !== o.payTo) {
      return new Error(`payTo: ${at} does not advertise ${o.payTo} as its payTo`, { cause: e });
    }
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

/** The Express app with the paid route, once the facilitator's /supported has been loaded and checked */
export async function createApiApp(o: ApiOptions): Promise<Express> {
  checkOptions(o);
  // One payTo and one network feed both the scheme and the route, since nothing compares the two later
  const { network, payTo, priceZat } = o;
  const server = new x402ResourceServer(facilitatorClient(o)).register(
    network,
    new PrepaidVoucherServerScheme({ payTo, network }),
  );
  const routes: RoutesConfig = {
    // Keyed without a verb so that HEAD, which Express hands to the GET handler, must pay too
    "/chunk": {
      accepts: {
        scheme: SCHEME,
        network,
        price: { amount: priceZat.toString(), asset: ASSET },
        payTo,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
      mimeType: "application/json",
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
  app.get("/chunk", chunk(priceZat));
  return app;
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
  const app = await createApiApp(o);
  const host = o.host ?? DEFAULT_HOST;
  const server = await listen(app, host, o.port ?? 0);

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    // close() also drops idle keep-alive connections on Node 19 and later, and waits for requests in flight
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      })),
  };
}
