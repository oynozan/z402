import { parseTerms } from "@z402/protocol";
import type { Express, Request, RequestHandler, Response } from "express";
import type { Log, ProviderRuntime } from "../runtime.js";
import {
  CatalogError,
  CatalogQueryError,
  parseListQuery,
  parseSearchQuery,
  type Catalog,
  type CatalogProvider,
} from "./catalog.js";

/** What the routes need of the provider whose key a request carried */
export type BazaarTenant = Pick<ProviderRuntime, "id" | "network" | "payTo" | "extra">;

export interface BazaarOptions {
  catalog: Catalog;
  /** Refuses a request whose key names no provider, and leaves the provider of any other in res.locals */
  authenticated: RequestHandler;
  /** Lets a request with no key by, and refuses one whose key names no provider */
  open: RequestHandler;
  /** Reads a JSON body into req.body, and notes one it cannot read in res.locals.unreadable */
  jsonBody: RequestHandler;
  /** The provider that `authenticated` found */
  providerOf(res: Response): BazaarTenant;
  log: Log;
}

export interface Bazaar {
  /** Tells the catalog of a payment that settled, and never throws */
  settled(tenant: BazaarTenant, body: unknown): void;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The catalog's view of a provider, which is held to the rail its runtime advertises */
function catalogProviderOf(tenant: BazaarTenant): CatalogProvider {
  const extra = tenant.extra();
  return {
    id: tenant.id,
    network: tenant.network,
    payTo: tenant.payTo,
    terms: parseTerms(extra),
    termsVersion: String(extra.termsVersion),
  };
}

function invalid(res: Response, message: string, index?: number): void {
  res.status(400).json({ error: "invalid_request", message, ...(index === undefined ? {} : { index }) });
}

/** Mounts the Bazaar routes of design §4.4 on the app, and answers for the hook that counts a settled payment */
export function mountBazaar(app: Express, o: BazaarOptions): Bazaar {
  const { catalog, log } = o;

  app.post("/discovery/resources", o.authenticated, o.jsonBody, (req: Request, res: Response) => {
    const unreadable: unknown = res.locals.unreadable;
    if (typeof unreadable === "string") {
      invalid(res, unreadable);
      return;
    }
    try {
      res.json({ x402Version: 2, items: catalog.declare(catalogProviderOf(o.providerOf(res)), req.body) });
    } catch (e) {
      // Anything but a refused declaration is ours, and goes on to the last resort that logs it
      if (!(e instanceof CatalogError)) throw e;
      invalid(res, e.message, e.index);
    }
  });

  const answer = (res: Response, read: () => unknown): void => {
    try {
      res.json(read());
    } catch (e) {
      if (!(e instanceof CatalogQueryError)) throw e;
      invalid(res, e.message);
    }
  };

  app.get("/discovery/resources", o.open, (req: Request, res: Response) => {
    answer(res, () => catalog.list(parseListQuery(req.query)));
  });

  app.get("/discovery/search", o.open, (req: Request, res: Response) => {
    answer(res, () => catalog.search(parseSearchQuery(req.query)));
  });

  return {
    settled: (tenant, body) => {
      try {
        const sent: Record<string, unknown> = isRecord(body) ? body : {};
        catalog.recordPaid(catalogProviderOf(tenant), sent.paymentPayload, sent.paymentRequirements);
      } catch (e) {
        // The payment is settled and its answer is on the way, so the failure is only reported
        try {
          log("catalog: could not record a paid call", e);
        } catch {}
      }
    },
  };
}
