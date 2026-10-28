/** One `accepts` entry of a listed resource, as x402 v2 sends it */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/**
 * An item of the facilitator's `GET /discovery/resources`: the Bazaar shape of @x402/extensions 2.28.0, plus the time
 * the service last declared the route, absent for a route listed from its paid calls alone, and its paid calls since
 * 00:00 UTC
 */
export interface DiscoveryResource {
  resource: string;
  type: string;
  x402Version: number;
  accepts: PaymentRequirement[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
  lastSeen?: string;
  paidCallsToday?: number;
}

/** A JSON value, as the Bazaar sends example inputs and answers */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type BodyType = "json" | "form-data" | "text";

/** What a route's bazaar declaration says an agent sends, from `extensions.bazaar.info.input` */
export interface RouteInput {
  queryParams: Record<string, string> | null;
  pathParams: Record<string, string> | null;
  bodyType: BodyType | null;
  /** The example body, a string for a text body, null for a route that takes none */
  body: Json;
}

/** The terms of the offer a route accepts, from its first readable `accepts` entry */
export interface RouteTerms {
  scheme: string | null;
  network: string | null;
  asset: string | null;
  payTo: string | null;
  windowZat: string | null;
  creditRatioBps: number | null;
  creditCapZat: string | null;
}

/** One paid route, reduced to what the site shows */
export interface Offer {
  url: string;
  serviceName: string | null;
  method: string;
  description: string | null;
  unit: string | null;
  note: string | null;
  priceZat: string | null;
  /** Lower case, in the order the Bazaar lists them */
  tags: string[];
  input: RouteInput | null;
  /** The example answer the route declares, as indented JSON */
  output: string | null;
  terms: RouteTerms | null;
  /** When the service last declared the route, in ms since the epoch, null for a route listed from its paid calls */
  lastSeen: number | null;
  paidCallsToday: number | null;
}

/** What the site read from the Bazaar */
export interface DiscoverySnapshot {
  /** Null where the read failed */
  offers: Offer[] | null;
  /** When the list was read, by the server's clock so a visitor's own clock moves no status, null once reads keep failing */
  at: number | null;
}
