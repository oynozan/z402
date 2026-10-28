import type { DiscoveryResourcesResponse } from "@x402/extensions/bazaar";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { MAX_LIMIT, type ListParams, type ServiceStatus } from "./catalog.js";
import { describeError } from "./probe.js";

/** What the HTTP side needs of the catalog */
export interface CatalogView {
  readonly size: number;
  list(params: ListParams): DiscoveryResourcesResponse;
  status(): ServiceStatus[];
}

export interface AppOptions {
  /** Receives one line for each request that failed unexpectedly */
  log?: (line: string) => void;
}

const CACHE = "max-age=5";
const NO_SEARCH = "There is no search: pull the list and match on your own machine.";
const MAX_OFFSET = 999_999_999;
const DIGITS_RE = /^[0-9]{1,9}$/;
const TEXT_PARAMS = ["type", "payTo", "scheme", "network", "extensions"] as const;

class BadQuery extends Error {}

/** A filter given once, where an empty one counts as not given */
function once(name: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") throw new BadQuery(`${name}: give it once`);
  return raw;
}

function wholeParam(name: string, raw: unknown, min: number, max: number): number | undefined {
  const text = once(name, raw);
  if (text === undefined) return undefined;
  const value = DIGITS_RE.test(text) ? Number(text) : Number.NaN;
  if (!(value >= min && value <= max)) throw new BadQuery(`${name}: expected a whole number from ${min} to ${max}`);
  return value;
}

function listParams(query: Request["query"]): ListParams {
  const params: ListParams = {};
  for (const name of TEXT_PARAMS) {
    const value = once(name, query[name]);
    if (value !== undefined) params[name] = value;
  }
  const limit = wholeParam("limit", query.limit, 1, MAX_LIMIT);
  if (limit !== undefined) params.limit = limit;
  const offset = wholeParam("offset", query.offset, 0, MAX_OFFSET);
  if (offset !== undefined) params.offset = offset;
  return params;
}

function fail(res: Response, status: number, error: string, message?: string): void {
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .json({ error, ...(message !== undefined && { message }) });
}

/** The Bazaar endpoint the stock client reads, plus the status the website shows */
export function createApp(catalog: CatalogView, o: AppOptions = {}): Express {
  const log = o.log ?? (() => undefined);
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" });
    if (req.method !== "OPTIONS") {
      next();
      return;
    }
    // The stock client sends a JSON content type on its GET, which makes a browser ask first
    const asked = req.get("access-control-request-headers");
    res.set({
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Max-Age": "600",
      ...(asked !== undefined && { "Access-Control-Allow-Headers": asked }),
    });
    res.status(204).end();
  });

  app.get("/discovery/resources", (req, res) => {
    let params: ListParams;
    try {
      params = listParams(req.query);
    } catch (e) {
      if (!(e instanceof BadQuery)) throw e;
      fail(res, 400, "bad_request", e.message);
      return;
    }
    res.set("Cache-Control", CACHE).json(catalog.list(params));
  });

  app.get("/discovery/status", (_req, res) => {
    res.set("Cache-Control", CACHE).json(catalog.status());
  });

  // Matching intents centrally would show the server what every agent wants
  app.get("/discovery/search", (_req, res) => {
    fail(res, 404, "not_supported", NO_SEARCH);
  });

  app.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, items: catalog.size });
  });

  app.use((_req, res) => {
    fail(res, 404, "not_found");
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    log(`${req.method} ${req.path} failed (${describeError(err)})`);
    if (res.headersSent) {
      next(err);
      return;
    }
    fail(res, 500, "internal_error");
  });

  return app;
}
