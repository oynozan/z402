/**
 * The four starter services in miniature: the same routes, methods, statuses and answer shapes (spec section 4), behind
 * the kit's real paywall, so a call from the flow is a real paid call (deposit, voucher, verify, handler, settle) on a
 * FakeChain. Every behaviour a test needs to break is a hook: `handlers` replaces what runs after payment, `prepare`
 * what runs before it, `unpaid` takes a route out from behind the paywall and `paywalled` puts a free route behind it.
 */
import { randomBytes } from "node:crypto";
import { createPaidService, type PaidRoute, type ServiceEnv } from "@z402/service-kit";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { ageRefusal } from "./age-shape.js";

export type RouteKey = "generate" | "markdown" | "embeddings" | "upload" | "hold" | "fetch" | "delete";

/** Runs instead of a route's own handler, which is after payment on a paid route, with the fake it belongs to */
export type Hook = (req: Request, res: Response, fake: FakeServices) => unknown;

export interface FakeOptions {
  /** What a stream answers with, one chunk per paid call; the last is `done`. Default five, so the flow stops first */
  chunks?: string[];
  /** The chain tip the drop box reports */
  tip?: number;
  handlers?: Partial<Record<RouteKey, Hook>>;
  /** Runs instead of the route's own checks, which are before payment on a paid route */
  prepare?: Partial<Record<RouteKey, RequestHandler[]>>;
  /** Routes that answer without the paywall */
  unpaid?: RouteKey[];
  /** Routes that are free in the real services and are put behind the paywall */
  paywalled?: RouteKey[];
}

export interface Drop {
  bytes: Buffer;
  token: string;
  expiresAtHeight: number;
}

interface Entry {
  key: RouteKey;
  method: PaidRoute["method"];
  path: string;
  probePath?: string;
  checks: RequestHandler[];
  handler: RequestHandler;
}

const BLOCKS_PER_CALL = 10;
const DEFAULT_CHUNKS = ["Hello there,", " nice to", " meet you", " today, my", " dear friend."];
const EXAMPLE_MARKDOWN = "This domain is for use in documentation examples without needing permission.";
const DEFAULT_PAID: readonly RouteKey[] = ["generate", "markdown", "embeddings", "upload", "hold"];

export const refuse = (res: Response, status: number, error: string, message?: string): void => {
  res.status(status).json(message === undefined ? { error } : { error, message });
};

export class FakeServices {
  /** "METHOD /path" of every request, in order, whatever answered it */
  readonly requests: string[] = [];
  readonly prompts: string[] = [];
  readonly inputs: unknown[] = [];
  readonly markdownUrls: string[] = [];
  readonly uploads: Buffer[] = [];
  readonly drops = new Map<string, Drop>();
  readonly deleted: string[] = [];
  readonly streams = new Map<string, { next: number }>();
  readonly tip: number;
  readonly #o: FakeOptions;

  constructor(o: FakeOptions = {}) {
    this.#o = o;
    this.tip = o.tip ?? 1042;
  }

  get chunks(): string[] {
    return this.#o.chunks ?? DEFAULT_CHUNKS;
  }

  async build(env: ServiceEnv): Promise<Express> {
    const paid = new Set<RouteKey>([...DEFAULT_PAID, ...(this.#o.paywalled ?? [])]);
    for (const key of this.#o.unpaid ?? []) paid.delete(key);
    const entries = this.entries().map((e) => {
      const hook = this.#o.handlers?.[e.key];
      const handler: RequestHandler = hook === undefined ? e.handler : (req, res) => hook(req, res, this);
      return { ...e, checks: this.#o.prepare?.[e.key] ?? e.checks, handler };
    });

    const { app } = await createPaidService({
      env,
      service: {
        serviceName: "Fake starter services",
        routes: entries
          .filter((e) => paid.has(e.key))
          .map(
            (e): PaidRoute => ({
              method: e.method,
              path: e.path,
              ...(e.probePath === undefined ? {} : { probePath: e.probePath }),
              description: `Fake ${e.key}`,
              unit: "call",
              discovery: { output: { example: {} } },
              prepare: e.checks,
            }),
          ),
      },
    });
    for (const e of entries) {
      // A route behind the paywall has its checks in front of the payment middleware already
      const chain = [...(paid.has(e.key) ? [] : e.checks), e.handler];
      if (e.method === "POST") app.post(e.path, ...chain);
      else if (e.method === "GET") app.get(e.path, ...chain);
      else app.delete(e.path, ...chain);
    }

    const root = express();
    root.use((req, _res, next) => {
      this.requests.push(`${req.method} ${req.path}`);
      next();
    });
    root.use(app);
    return root;
  }

  private entries(): Entry[] {
    return [
      { key: "generate", method: "POST", path: "/v1/generate", checks: [express.json({ strict: false }), this.checkGenerate], handler: this.generate },
      { key: "markdown", method: "GET", path: "/v1/markdown", checks: [this.checkMarkdown], handler: this.markdown },
      { key: "embeddings", method: "POST", path: "/v1/embeddings", checks: [express.json({ strict: false }), this.checkEmbeddings], handler: this.embeddings },
      { key: "upload", method: "POST", path: "/v1/drops", checks: [express.raw({ type: () => true, limit: "64kb" }), this.checkUpload], handler: this.upload },
      { key: "hold", method: "POST", path: "/v1/drops/:id/hold", probePath: "/v1/drops/example/hold", checks: [this.checkHold], handler: this.hold },
      { key: "fetch", method: "GET", path: "/v1/drops/:id", probePath: "/v1/drops/example", checks: [], handler: this.fetch },
      { key: "delete", method: "DELETE", path: "/v1/drops/:id", probePath: "/v1/drops/example", checks: [], handler: this.delete },
    ];
  }

  private checkGenerate: RequestHandler = (req, res, next) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(res, 400, "invalid_request");
    const fields = body as Record<string, unknown>;
    if (typeof fields["stream"] === "string") {
      const stream = this.streams.get(fields["stream"]);
      if (stream === undefined) return refuse(res, 404, "unknown_stream");
      if (stream.next >= this.chunks.length) return refuse(res, 410, "stream_finished");
      return next();
    }
    if (typeof fields["prompt"] !== "string" || fields["prompt"].trim() === "") return refuse(res, 400, "invalid_request");
    next();
  };

  private generate: RequestHandler = (req, res) => {
    const body = req.body as { prompt?: string; stream?: string };
    let id = body.stream;
    if (id === undefined) {
      id = randomBytes(9).toString("base64url");
      this.streams.set(id, { next: 0 });
      this.prompts.push(String(body.prompt));
    }
    const stream = this.streams.get(id) ?? { next: 0 };
    const index = stream.next++;
    const done = index === this.chunks.length - 1;
    res.json({ stream: id, index, text: this.chunks[index] ?? "", done, ...(done && { finishReason: "stop" }) });
  };

  private checkMarkdown: RequestHandler = (req, res, next) => {
    const url = req.query["url"];
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) refuse(res, 400, "invalid_url");
    else next();
  };

  private markdown: RequestHandler = (req, res) => {
    const url = String(req.query["url"]);
    this.markdownUrls.push(url);
    res.json({
      url,
      finalUrl: url,
      title: "Example Domain",
      byline: null,
      markdown: EXAMPLE_MARKDOWN,
      length: EXAMPLE_MARKDOWN.length,
      truncated: false,
    });
  };

  private checkEmbeddings: RequestHandler = (req, res, next) => {
    const input: unknown = (req.body as { input?: unknown } | undefined)?.input;
    const list = typeof input === "string" ? [input] : input;
    if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === "string" && s.trim() !== "")) {
      return refuse(res, 400, "invalid_request", "input must be a string or an array of strings");
    }
    next();
  };

  private embeddings: RequestHandler = (req, res) => {
    const input = (req.body as { input: string | string[] }).input;
    this.inputs.push(input);
    const list = typeof input === "string" ? [input] : input;
    const tokens = list.length * 2;
    res.json({
      object: "list",
      model: "fake-embed",
      dimensions: 8,
      data: list.map((_, index) => ({
        object: "embedding",
        index,
        embedding: Array.from({ length: 8 }, (__, i) => (index + 1) * (i + 1) * 0.01),
      })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  };

  private checkUpload: RequestHandler = (req, res, next) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return refuse(res, 400, "empty_body");
    const reason = ageRefusal(body);
    if (reason !== undefined) {
      res.status(415).json({ error: "not_encrypted", reason });
      return;
    }
    next();
  };

  private upload: RequestHandler = (req, res) => {
    const bytes = req.body as Buffer;
    const id = randomBytes(16).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const expiresAtHeight = this.tip + BLOCKS_PER_CALL;
    this.uploads.push(Buffer.from(bytes));
    this.drops.set(id, { bytes: Buffer.from(bytes), token, expiresAtHeight });
    res.status(201).json({ id, deleteToken: token, size: bytes.length, tip: this.tip, expiresAtHeight });
  };

  private checkHold: RequestHandler = (req, res, next) => {
    if (this.drops.has(String(req.params["id"]))) next();
    else refuse(res, 404, "unknown_drop");
  };

  private hold: RequestHandler = (req, res) => {
    const id = String(req.params["id"]);
    const drop = this.drops.get(id);
    if (drop === undefined) return refuse(res, 404, "unknown_drop");
    drop.expiresAtHeight += BLOCKS_PER_CALL;
    res.json({ id, tip: this.tip, expiresAtHeight: drop.expiresAtHeight });
  };

  private fetch: RequestHandler = (req, res) => {
    const drop = this.drops.get(String(req.params["id"]));
    if (drop === undefined) return refuse(res, 404, "unknown_drop");
    res
      .set({
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Expires-At-Height": String(drop.expiresAtHeight),
      })
      .send(drop.bytes);
  };

  private delete: RequestHandler = (req, res) => {
    const id = String(req.params["id"]);
    const drop = this.drops.get(id);
    if (drop === undefined) return refuse(res, 404, "unknown_drop");
    const token = /^bearer +(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    if (token === undefined) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }
    if (token !== drop.token) return refuse(res, 403, "forbidden");
    this.drops.delete(id);
    this.deleted.push(id);
    res.status(204).end();
  };
}
