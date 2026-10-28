import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "./app.js";
import { Catalog } from "./catalog.js";
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_REFRESH_MS, DEFAULT_TIMEOUT_MS, type Target } from "./config.js";

export { createApp, type AppOptions, type CatalogView } from "./app.js";
export {
  Catalog,
  type CatalogOptions,
  type ListedResource,
  type ListParams,
  type ListResponse,
  type ServiceStatus,
} from "./catalog.js";
export { ConfigError, loadConfig, type DiscoveryConfig, type Env, type Target } from "./config.js";

export interface DiscoveryOptions {
  /** Base URLs of the kit-based services */
  services: readonly string[];
  /** Routes that are not built on the kit */
  targets?: readonly Target[];
  /** Default 30000 */
  refreshMs?: number;
  /** Default 5000 for each request */
  timeoutMs?: number;
  /** Default 127.0.0.1 */
  host?: string;
  /** Default 4030, and 0 picks a free port */
  port?: number;
  /** Receives the log lines, default stderr */
  log?: (line: string) => void;
}

export interface DiscoveryHandle {
  url: string;
  catalog: Catalog;
  close(): Promise<void>;
}

const CLOSE_GRACE_MS = 1_000;

/** Listens on the host and port, and rejects naming HOST or PORT */
function listen(app: Express, host: string, port: number, log: (line: string) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    const refuse = (e: NodeJS.ErrnoException): void => {
      const field = e.code === "EADDRINUSE" || e.code === "EACCES" ? "PORT" : "HOST";
      reject(new Error(`${field}: cannot listen on ${host}:${port} (${e.code ?? e.message})`));
    };
    server.once("error", refuse);
    server.listen(port, host, () => {
      server.off("error", refuse);
      server.on("error", (e) => log(`http server error (${e.message})`));
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // A client that stays mid-request would otherwise hold the shutdown up
    const force = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
    force.unref();
    server.close((err) => {
      clearTimeout(force);
      if (err === undefined) resolve();
      else reject(err);
    });
    server.closeIdleConnections();
  });
}

/** Runs the first refresh, then listens, so that a discovery that reports ready already holds its catalog */
export async function startDiscovery(o: DiscoveryOptions): Promise<DiscoveryHandle> {
  const log = o.log ?? ((line: string) => console.error(`discovery: ${line}`));
  const catalog = new Catalog({
    services: o.services,
    targets: o.targets,
    timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    log,
  });
  await catalog.start(o.refreshMs ?? DEFAULT_REFRESH_MS);

  const host = o.host ?? DEFAULT_HOST;
  let server: Server;
  try {
    server = await listen(createApp(catalog, { log }), host, o.port ?? DEFAULT_PORT, log);
  } catch (e) {
    await catalog.stop();
    throw e;
  }

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    catalog,
    close: () => (closing ??= catalog.stop().then(() => closeServer(server))),
  };
}
