/** One `accepts` entry of a discovered resource, as x402 v2 sends it */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** An item of `GET /discovery/resources`, the Bazaar shape of @x402/extensions 2.28.0 */
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
}

/** A service entry of `GET /discovery/status`, every field as the discovery service may send it */
export interface DiscoveryStatusEntry {
  serviceName?: string;
  url?: string;
  up?: boolean;
  ready?: boolean;
  latencyMs?: number | null;
  checkedAt?: string | null;
  callsToday?: number | string | null;
  unit?: string | null;
  priceZat?: string | number | null;
}

/** A JSON value, as discovery sends example inputs and answers */
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
  /** Lower case, in the order discovery lists them */
  tags: string[];
  input: RouteInput | null;
  /** The example answer the route declares, as indented JSON */
  output: string | null;
  terms: RouteTerms | null;
}

/** One status entry after the loose fields are checked */
export interface ServiceStatus {
  serviceName: string | null;
  url: string | null;
  up: boolean;
  /** Null when the entry does not say */
  ready: boolean | null;
  latencyMs: number | null;
  callsToday: number | null;
  unit: string | null;
  priceZat: string | null;
}

/** What the server read from discovery, null where a read failed */
export interface DiscoverySnapshot {
  offers: Offer[] | null;
  status: ServiceStatus[] | null;
}
