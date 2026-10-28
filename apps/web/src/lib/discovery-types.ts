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

export interface DiscoveryResourcesResponse {
  x402Version: number;
  items: DiscoveryResource[];
  pagination: { limit: number; offset: number; total: number };
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

export interface DiscoveryStatusResponse {
  updatedAt?: string;
  services: DiscoveryStatusEntry[];
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
}

/** One status entry after the loose fields are checked */
export interface ServiceStatus {
  serviceName: string | null;
  url: string | null;
  up: boolean;
  /** Null when the entry does not say */
  ready: boolean | null;
  callsToday: number | null;
  unit: string | null;
  priceZat: string | null;
}

/** What the server read from discovery, null where a read failed */
export interface DiscoverySnapshot {
  offers: Offer[] | null;
  status: ServiceStatus[] | null;
}
