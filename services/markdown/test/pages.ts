/** A local web server for fetch and service tests, and the one policy change they need to reach it */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isPublicAddress, type AddressPolicy } from "../src/guard.js";

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

export interface PageServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  port: number;
  /** Request paths in the order they arrived */
  hits: string[];
  close(): Promise<void>;
}

/** The strict policy plus 127.0.0.1, where the test server listens */
export const allowLoopback: AddressPolicy = (address) => address === "127.0.0.1" || isPublicAddress(address);

export function html(body: string, type = "text/html; charset=utf-8"): Route {
  return (_req, res) => {
    res.writeHead(200, { "content-type": type }).end(body);
  };
}

export function redirect(location: string, status = 302): Route {
  return (_req, res) => {
    res.writeHead(status, { location }).end();
  };
}

export async function startPages(routes: Record<string, Route>): Promise<PageServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://pages.test").pathname;
    hits.push(path);
    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/html" }).end("<p>not found</p>");
      return;
    }
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
  };
}
