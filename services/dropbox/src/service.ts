/**
 * The encrypted drop box (design §4.4). Two paid routes upload an age-encrypted blob and hold it longer, and two free
 * ones fetch and delete it. Every refusal that can come before payment does, so the body is read, checked and sized in
 * `prepare`. An upload is undone when its delivery fails and a hold is applied only once its delivery succeeded.
 */
import { createLightwalletdClient, type LightwalletdClient } from "@z402/lightwalletd";
import { ConfigError, createPaidService, onDelivered, type PaidRoute, type ServiceEnv } from "@z402/service-kit";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { isAgeEncrypted } from "./age.js";
import type { DropboxConfig } from "./config.js";
import { EXAMPLE_AGE_FILE } from "./example.js";
import { stderr, type Log } from "./log.js";
import { DropStore, isDropId, type DropMeta } from "./store.js";
import { createTipSource, type TipSource } from "./tip.js";

export interface DropboxOptions {
  env: ServiceEnv;
  config: DropboxConfig;
  /** Defaults to lightwalletd at config.lwdUrl, which also sweeps the store on every new tip */
  tips?: TipSource;
  /** Defaults to the directory config.dir */
  store?: DropStore;
  log?: Log;
}

export interface DropboxService {
  app: Express;
  store: DropStore;
  tips: TipSource;
  /** Stops the tip source, which the service starts itself */
  close(): Promise<void>;
}

const BEARER = /^bearer +(\S+)$/i;

function idOf(req: Request): string | undefined {
  const id = req.params["id"];
  return typeof id === "string" ? id : undefined;
}

function bearerOf(req: Request): string | undefined {
  return BEARER.exec(req.get("authorization") ?? "")?.[1];
}

// Express 5 leaves req.body undefined for a request without one
function uploadOf(req: Request): Buffer | undefined {
  const body: unknown = req.body;
  return Buffer.isBuffer(body) && body.length > 0 ? body : undefined;
}

/** The HTTP status of an error from the body parser, if it has one */
function statusOf(e: unknown): number | undefined {
  return typeof e === "object" && e !== null && "status" in e && typeof e.status === "number" ? e.status : undefined;
}

function unknownDrop(res: Response): void {
  res.status(404).json({ error: "unknown_drop" });
}

function openStore(config: DropboxConfig, log: Log): DropStore {
  try {
    return new DropStore({ dir: config.dir, maxTotalBytes: config.maxTotalBytes, log });
  } catch (e) {
    throw new ConfigError(`DROPBOX_DIR: cannot use ${config.dir} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

export async function createDropboxService(o: DropboxOptions): Promise<DropboxService> {
  const { env, config } = o;
  const log = o.log ?? stderr;
  const store = o.store ?? openStore(config, log);

  let client: LightwalletdClient | undefined;
  let tips = o.tips;
  if (tips === undefined) {
    client = createLightwalletdClient({ url: config.lwdUrl });
    tips = createTipSource({ client, pollMs: config.tipPollMs, onTip: (tip) => store.sweep(tip), log });
  }
  const clock = tips;

  const tipOrRefuse = (res: Response): number | undefined => {
    const tip = clock.tip();
    if (tip === undefined) res.status(503).json({ error: "not_ready" });
    return tip;
  };

  // Removes the drop on the spot once the tip reaches its expiry, and a tip that is not known expires nothing
  const liveDrop = (id: string | undefined, tip: number | undefined): Readonly<DropMeta> | undefined => {
    if (id === undefined || !isDropId(id)) return undefined;
    const meta = store.get(id);
    if (meta === undefined) return undefined;
    if (tip !== undefined && tip >= meta.expiresAtHeight) {
      store.remove(id);
      return undefined;
    }
    return meta;
  };

  // A hold adds a whole call's blocks or none, so a drop one block short of the cap is already at it
  const exceedsCap = (meta: Readonly<DropMeta>, tip: number): boolean =>
    meta.expiresAtHeight + config.blocksPerCall > tip + config.maxHoldBlocks;

  const capReached = (res: Response): void => {
    res.status(409).json({ error: "hold_cap_reached", maxHoldBlocks: config.maxHoldBlocks });
  };

  const parseBody = express.raw({ type: () => true, limit: config.maxBytes });
  const readBody: RequestHandler = (req, res, next) => {
    parseBody(req, res, (e?: unknown) => {
      if (e === undefined) {
        next();
        return;
      }
      const status = statusOf(e);
      if (status === 413) res.status(413).json({ error: "too_large" });
      else if (status !== undefined && status < 500) res.status(400).json({ error: "bad_body" });
      else next(e);
    });
  };

  const checkUpload: RequestHandler = (req, res, next) => {
    const bytes = uploadOf(req);
    if (bytes === undefined) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    const verdict = isAgeEncrypted(bytes);
    if (!verdict.ok) {
      res.status(415).json({ error: "not_encrypted", reason: verdict.reason });
      return;
    }
    if (!store.hasRoom(bytes.length)) {
      res.status(507).json({ error: "storage_full" });
      return;
    }
    next();
  };

  const checkHold: RequestHandler = (req, res, next) => {
    const tip = tipOrRefuse(res);
    if (tip === undefined) return;
    const meta = liveDrop(idOf(req), tip);
    if (meta === undefined) {
      unknownDrop(res);
      return;
    }
    if (exceedsCap(meta, tip)) {
      capReached(res);
      return;
    }
    next();
  };

  const blocks = `${config.blocksPerCall} blocks`;
  const routes: PaidRoute[] = [
    {
      method: "POST",
      path: "/v1/drops",
      description: `Holds one age-encrypted blob for ${config.blocksPerCall} blocks; pay again to hold it longer.`,
      unit: blocks,
      note: "Only client-side encrypted (age) blobs. Size and time are capped.",
      discovery: {
        bodyType: "text",
        // Bazaar types a body as an object, but a text body is a string and the schema below says so
        input: EXAMPLE_AGE_FILE as unknown as Record<string, unknown>,
        inputSchema: { type: "string" },
        output: {
          example: {
            id: "q3Zs0mYbT7cWpAxK1nGhUw",
            deleteToken: "m4X1rVd9Tq0uYb7LkGfH2sNaPzE8cJwO5iRtBvQeXyA",
            size: 349,
            tip: 1042,
            expiresAtHeight: 1052,
          },
        },
      },
      prepare: [readBody, checkUpload],
    },
    {
      method: "POST",
      path: "/v1/drops/:id/hold",
      probePath: "/v1/drops/example/hold",
      description: `Holds an existing drop for ${config.blocksPerCall} more blocks.`,
      unit: blocks,
      discovery: {
        bodyType: "json",
        input: {},
        pathParams: { id: "<drop id>" },
        pathParamsSchema: { properties: { id: { type: "string" } }, required: ["id"] },
        output: { example: { id: "q3Zs0mYbT7cWpAxK1nGhUw", tip: 1046, expiresAtHeight: 1062 } },
      },
      prepare: [checkHold],
    },
  ];

  let app: Express;
  try {
    ({ app } = await createPaidService({
      env,
      service: { serviceName: "Encrypted drop box", tags: ["storage", "handoff", "encrypted"], routes },
      ready: () => clock.tip() !== undefined,
    }));
  } catch (e) {
    client?.close();
    throw e;
  }

  app.post("/v1/drops", (req, res) => {
    const tip = tipOrRefuse(res);
    if (tip === undefined) return;
    const bytes = uploadOf(req);
    if (bytes === undefined) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    const { meta, deleteToken } = store.put({ bytes, expiresAtHeight: tip + config.blocksPerCall });
    // A refused settlement or a lost client makes this a failed delivery, which must not leave a free drop
    onDelivered(res, {
      failed: () => {
        store.remove(meta.id);
      },
    });
    res.status(201).json({ id: meta.id, deleteToken, size: meta.size, tip, expiresAtHeight: meta.expiresAtHeight });
  });

  app.post("/v1/drops/:id/hold", (req, res) => {
    const tip = tipOrRefuse(res);
    if (tip === undefined) return;
    // Both checks ran before payment, so they only fail here if the drop changed in the meantime
    const meta = liveDrop(idOf(req), tip);
    if (meta === undefined) {
      unknownDrop(res);
      return;
    }
    if (exceedsCap(meta, tip)) {
      capReached(res);
      return;
    }
    onDelivered(res, {
      ok: () => {
        // Against the drop and the tip as they are now, since a settlement can take a while
        const current = store.get(meta.id);
        if (current === undefined) return;
        const now = clock.tip() ?? tip;
        store.extend(meta.id, Math.min(current.expiresAtHeight + config.blocksPerCall, now + config.maxHoldBlocks));
      },
    });
    res.json({ id: meta.id, tip, expiresAtHeight: meta.expiresAtHeight + config.blocksPerCall });
  });

  // The id is enough to fetch a drop and the delete token to delete it, so neither route is paid
  app.get("/v1/drops/:id", (req, res) => {
    const meta = liveDrop(idOf(req), clock.tip());
    const bytes = meta === undefined ? undefined : store.read(meta.id);
    if (meta === undefined || bytes === undefined) {
      unknownDrop(res);
      return;
    }
    res
      .set({
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Expires-At-Height": String(meta.expiresAtHeight),
      })
      .send(bytes);
  });

  app.delete("/v1/drops/:id", (req, res) => {
    const meta = liveDrop(idOf(req), clock.tip());
    if (meta === undefined) {
      unknownDrop(res);
      return;
    }
    const token = bearerOf(req);
    if (token === undefined) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }
    if (!store.checkToken(meta.id, token)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    store.remove(meta.id);
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    log(`dropbox: request failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: "internal_error" });
  });

  clock.start();
  return {
    app,
    store,
    tips: clock,
    close: async () => {
      clock.stop();
      client?.close();
    },
  };
}
