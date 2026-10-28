/** Fake services for the tests, each one listening on a free port and closed by closeAll */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Origin {
  url: string;
  /** "METHOD /path?query" of every request, in arrival order */
  requests: string[];
}

export const PAY_TO = `uregtest1${"q".repeat(60)}`;

const open: Array<() => Promise<void>> = [];

export async function closeAll(): Promise<void> {
  for (const close of open.splice(0)) await close();
}

/** A service whose answers the test writes */
export async function origin(handler: Handler): Promise<Origin> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** Accepts connections and never answers them */
export async function hangingOrigin(): Promise<Origin> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    requests.push("connect");
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A URL on a port that nothing listens on */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export function pathOf(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

/** Routes a request by "METHOD /path" and answers 404 for the rest */
export function router(table: Record<string, Handler>): Handler {
  return (req, res) => {
    const handler = table[`${req.method} ${pathOf(req)}`];
    if (handler === undefined) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    handler(req, res);
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface HealthRouteSpec {
  method: string;
  path: string;
  probePath?: string;
  unit?: string;
}

export interface HealthOptions {
  ready?: boolean;
  service?: string;
  callsToday?: number;
  priceZat?: string;
}

/** What the service kit's /health answers */
export function healthBody(routes: HealthRouteSpec[], o: HealthOptions = {}): Record<string, unknown> {
  return {
    ok: true,
    service: o.service ?? "Fake",
    ready: o.ready ?? true,
    network: "zcash:regtest",
    priceZat: o.priceZat ?? "500",
    callsToday: o.callsToday ?? 0,
    routes: routes.map((r) => ({
      method: r.method,
      path: r.path,
      ...(r.probePath !== undefined && { probePath: r.probePath }),
      unit: r.unit ?? "call",
    })),
  };
}

export function sendHealth(res: ServerResponse, routes: HealthRouteSpec[], o: HealthOptions = {}): void {
  sendJson(res, o.ready === false ? 503 : 200, healthBody(routes, o));
}

export interface PaymentRequiredOptions {
  payTo?: string;
  scheme?: string;
  network?: string;
  amount?: string;
  description?: string;
  serviceName?: string;
  /** Replaces or adds fields of the resource object */
  resource?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** A valid v2 PaymentRequired for a route */
export function paymentRequired(url: string, o: PaymentRequiredOptions = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url,
      description: o.description ?? `The route at ${url}`,
      mimeType: "application/json",
      serviceName: o.serviceName ?? "Fake",
      ...o.resource,
    },
    accepts: [
      {
        scheme: o.scheme ?? "prepaid-voucher",
        network: o.network ?? "zcash:regtest",
        asset: "ZEC",
        amount: o.amount ?? "500",
        payTo: o.payTo ?? PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    ...(o.extensions !== undefined && { extensions: o.extensions }),
  };
}

/** The smallest bazaar declaration that passes the spec check */
export function bazaar(method: string): Record<string, unknown> {
  return { info: { input: { type: "http", method } }, schema: { type: "object" } };
}

export function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** A 402 whose header carries `value`, which may be anything */
export function send402(res: ServerResponse, value: unknown): void {
  res.writeHead(402, { "content-type": "application/json", "payment-required": encode(value) });
  res.end("{}");
}

/** A 402 whose header is exactly `header` */
export function send402Raw(res: ServerResponse, header: string): void {
  res.writeHead(402, { "content-type": "application/json", "payment-required": header });
  res.end("{}");
}
