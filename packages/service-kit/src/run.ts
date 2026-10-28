import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface Listening {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const HEADERS_TIMEOUT_MS = 15_000;
/** Time to receive a whole request, body included, which a 1 MiB upload on a slow link still fits */
const REQUEST_TIMEOUT_MS = 30_000;

/** Listens on host:port (0 picks a free port) and rejects naming HOST or PORT */
export function serve(app: Express, o: { host: string; port: number }): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    // Node's defaults let a client trickle one request for 5 minutes while its body is buffered before payment
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    const refuse = (e: NodeJS.ErrnoException): void => {
      const field = e.code === "EADDRINUSE" || e.code === "EACCES" ? "PORT" : "HOST";
      reject(new Error(`${field}: cannot listen on ${o.host}:${o.port} (${e.code ?? e.message})`));
    };
    server.once("error", refuse);
    server.listen(o.port, o.host, () => {
      server.off("error", refuse);
      server.on("error", (e) => console.error("http server error", e));
      const { port } = server.address() as AddressInfo;
      let closing: Promise<void> | undefined;
      // server.close() only closes the connections idle at that moment, so later ones are closed as their calls end
      server.on("request", (_req, res) => {
        res.once("finish", () => {
          if (closing !== undefined) setImmediate(() => server.closeIdleConnections());
        });
      });
      resolve({
        url: `http://${o.host.includes(":") ? `[${o.host}]` : o.host}:${port}`,
        server,
        close: () =>
          (closing ??= new Promise<void>((done, fail) => {
            server.close((err) => (err === undefined ? done() : fail(err)));
            server.closeIdleConnections();
          })),
      });
    });
  });
}

const SHUTDOWN_MS = 5_000;

/**
 * The process wrapper every service main uses: one ready line on stdout, logs and errors on stderr, exit 1 on a start
 * failure, and SIGINT or SIGTERM closes the service (exit 1 if that takes more than 5 s).
 */
export function runMain(name: string, start: () => Promise<{ readyLine: string; close(): Promise<void> }>): void {
  start().then(
    (running) => {
      console.log(`${name} ${running.readyLine}`);
      const stop = (): void => {
        setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
        running.close().then(
          () => process.exit(0),
          (err: unknown) => {
            console.error(`${name}: shutdown failed`, err);
            process.exit(1);
          },
        );
      };
      // Once, so that a second signal gets the default and ends the process at once
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    },
    (err: unknown) => {
      console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
