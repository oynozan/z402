/**
 * The catalog behind /discovery/resources. Every route keeps its last good probe, so a service that goes down, is not
 * ready or answers a bad 402 keeps the items it had, with their old lastUpdated. A route that a service stops listing
 * in /health while it is up is dropped. Origins are probed in parallel and a refresh never overlaps another. The next
 * refresh comes sooner while anything is down, so a service that starts late is listed within seconds.
 */
import type {
  DiscoveryResource,
  DiscoveryResourcesResponse,
  ListDiscoveryResourcesParams,
} from "@x402/extensions/bazaar";
import type { ProbeMethod, Target } from "./config.js";
import {
  checkResourcePath,
  describeError,
  pathnameOf,
  probeHealth,
  probeRoute,
  routePaths,
  routeUrl,
  type HealthRoute,
  type ProbeContext,
  type ProbedRoute,
  type RouteProbe,
} from "./probe.js";

export type ListParams = ListDiscoveryResourcesParams;

export interface ServiceStatus {
  serviceName: string | null;
  /** The public origin, taken from the resource URLs the service declares */
  url: string | null;
  up: boolean;
  ready: boolean;
  latencyMs: number | null;
  /** When the service was last checked, whether or not it answered */
  checkedAt: string | null;
  callsToday: number | null;
  /** What one call to the first route buys */
  unit: string | null;
  priceZat: string | null;
}

export interface CatalogOptions {
  /** Base URLs of kit-based services, in the order they are listed */
  services: readonly string[];
  /** Routes that are not built on the kit, listed after the services and probed without a /health */
  targets?: readonly Target[];
  timeoutMs: number;
  /** How soon to look again while anything is down, never later than the interval given to start */
  retryMs?: number;
  /** Receives one line for each change of state, and never a secret */
  log?: (line: string) => void;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const DEFAULT_RETRY_MS = 5_000;
const X402_VERSION = 2;

interface Slot {
  key: string;
  method: ProbeMethod;
  url: string;
  /** What the path of the resource URL in its 402 has to end in, for the 402 to be about this route */
  paths: readonly string[];
  item: DiscoveryResource | undefined;
  /** Why the last probe of this route failed */
  failure: string | undefined;
}

interface ServiceState {
  base: string;
  slots: Slot[];
  status: ServiceStatus;
  /** Why the last check of the service failed */
  failure: string | undefined;
}

function emptyStatus(): ServiceStatus {
  return {
    serviceName: null,
    url: null,
    up: false,
    ready: false,
    latencyMs: null,
    checkedAt: null,
    callsToday: null,
    unit: null,
    priceZat: null,
  };
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

function itemOf(route: ProbedRoute, at: Date): DiscoveryResource {
  return {
    resource: route.url,
    type: "http",
    x402Version: X402_VERSION,
    accepts: route.accepts,
    lastUpdated: at.toISOString(),
    ...(route.description !== undefined && { description: route.description }),
    ...(route.mimeType !== undefined && { mimeType: route.mimeType }),
    ...(route.serviceName !== undefined && { serviceName: route.serviceName }),
    ...(route.tags !== undefined && { tags: route.tags }),
    ...(route.iconUrl !== undefined && { iconUrl: route.iconUrl }),
    ...(route.extensions !== undefined && { extensions: route.extensions }),
  };
}

function whole(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function matches(item: DiscoveryResource, p: ListParams): boolean {
  if (p.type !== undefined && item.type !== p.type) return false;
  if (p.payTo !== undefined || p.scheme !== undefined || p.network !== undefined) {
    // One offer has to satisfy all of the payment filters together
    const offered = item.accepts.some(
      (a) =>
        (p.payTo === undefined || a.payTo === p.payTo) &&
        (p.scheme === undefined || a.scheme === p.scheme) &&
        (p.network === undefined || a.network === p.network),
    );
    if (!offered) return false;
  }
  return p.extensions === undefined || (item.extensions !== undefined && Object.hasOwn(item.extensions, p.extensions));
}

export class Catalog {
  readonly #services: ServiceState[];
  readonly #targets: Slot[];
  readonly #timeoutMs: number;
  readonly #retryMs: number;
  readonly #log: (line: string) => void;
  readonly #stopping = new AbortController();
  #items: DiscoveryResource[] = [];
  #running: Promise<void> | undefined;
  #complete = false;
  #started = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(o: CatalogOptions) {
    this.#services = o.services.map((base) => ({ base, slots: [], status: emptyStatus(), failure: undefined }));
    this.#targets = (o.targets ?? []).map(({ method, url }) => {
      const path = pathnameOf(url);
      const paths = path === undefined ? [] : [path];
      return { key: `${method} ${url}`, method, url, paths, item: undefined, failure: undefined };
    });
    this.#timeoutMs = o.timeoutMs;
    this.#retryMs = o.retryMs ?? DEFAULT_RETRY_MS;
    const log = o.log;
    this.#log = (line) => {
      try {
        log?.(line);
      } catch {
        // A broken logger must not stop discovery
      }
    };
  }

  /** How many items the catalog holds */
  get size(): number {
    return this.#items.length;
  }

  list(params: ListParams = {}): DiscoveryResourcesResponse {
    const matched = this.#items.filter((item) => matches(item, params));
    const limit = whole(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = whole(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return {
      x402Version: X402_VERSION,
      items: matched.slice(offset, offset + limit),
      pagination: { limit, offset, total: matched.length },
    };
  }

  /** One entry for each configured service, in order */
  status(): ServiceStatus[] {
    return this.#services.map((s) => ({ ...s.status }));
  }

  /** Probes everything once, and callers that arrive during a refresh share it so that two never overlap */
  refresh(): Promise<void> {
    if (this.#stopping.signal.aborted) return Promise.resolve();
    this.#running ??= this.#refreshAll().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Refreshes now and again after every interval, and answers once the first refresh is done */
  start(refreshMs: number): Promise<void> {
    const first = this.refresh();
    if (!this.#started) {
      this.#started = true;
      const next = (): void => this.#schedule(refreshMs);
      void first.then(next, next);
    }
    return first;
  }

  /** Cancels the probes in flight and the timer, while the items stay readable */
  async stop(): Promise<void> {
    this.#stopping.abort();
    clearTimeout(this.#timer);
    await this.#running;
  }

  #schedule(refreshMs: number): void {
    if (this.#stopping.signal.aborted) return;
    const wait = this.#complete ? refreshMs : Math.min(refreshMs, this.#retryMs);
    const next = (): void => this.#schedule(refreshMs);
    this.#timer = setTimeout(() => void this.refresh().then(next, next), wait);
    this.#timer.unref();
  }

  #context(): ProbeContext {
    return { timeoutMs: this.#timeoutMs, signal: this.#stopping.signal };
  }

  async #refreshAll(): Promise<void> {
    const outcomes = await Promise.all([
      ...this.#services.map((s) => this.#guarded(s.base, () => this.#refreshService(s))),
      ...this.#targets.map((t) => this.#guarded(t.key, () => this.#refreshTarget(t))),
    ]);
    this.#complete = outcomes.every(Boolean);
  }

  /** A failure nobody foresaw is logged and counts as incomplete, and never reaches the caller */
  async #guarded(what: string, run: () => Promise<boolean>): Promise<boolean> {
    try {
      return await run();
    } catch (e) {
      this.#log(`${what} could not be checked (${describeError(e)})`);
      return false;
    }
  }

  /** True when the service is up and ready and every route answered */
  async #refreshService(s: ServiceState): Promise<boolean> {
    const ctx = this.#context();
    const checkedAt = new Date();
    const probe = await probeHealth(s.base, ctx);
    if (this.#stopping.signal.aborted) return false;
    if (!probe.ok) {
      if (s.failure !== probe.reason) this.#log(`${s.base} is down (${probe.reason})`);
      s.failure = probe.reason;
      const down = { up: false, ready: false, latencyMs: null, checkedAt: checkedAt.toISOString(), callsToday: null };
      s.status = { ...s.status, ...down };
      return false;
    }

    const { health } = probe;
    const slots = this.#slotsFor(s, health.routes);
    const probed = await Promise.all(
      slots.map(async (slot) => ({ slot, result: await probeRoute(slot.method, slot.url, ctx) })),
    );
    if (this.#stopping.signal.aborted) return false;

    const at = new Date();
    let routesOk = true;
    for (const { slot, result } of probed) routesOk = this.#applyRoute(slot, result, at) && routesOk;

    if (!s.status.up) {
      const routes = `${slots.length} route${slots.length === 1 ? "" : "s"}`;
      this.#log(`${s.base} is up${health.ready ? "" : " but not ready"} with ${routes}`);
    } else if (s.status.ready !== health.ready) {
      this.#log(`${s.base} is ${health.ready ? "ready" : "not ready"}`);
    }
    const first = slots.find((slot) => slot.item !== undefined)?.item;
    s.failure = undefined;
    s.slots = slots;
    s.status = {
      serviceName: health.service ?? first?.serviceName ?? s.status.serviceName,
      url: (first !== undefined ? originOf(first.resource) : null) ?? s.status.url,
      up: true,
      ready: health.ready,
      latencyMs: Math.round(probe.latencyMs),
      checkedAt: checkedAt.toISOString(),
      callsToday: health.callsToday,
      unit: health.routes[0]?.unit ?? s.status.unit,
      priceZat: health.priceZat ?? s.status.priceZat,
    };
    this.#rebuild();
    return health.ready && routesOk;
  }

  /** The routes the service lists now, each carrying what the catalog already knew of it */
  #slotsFor(s: ServiceState, routes: HealthRoute[]): Slot[] {
    const known = new Map(s.slots.map((slot) => [slot.key, slot] as const));
    const slots = new Map<string, Slot>();
    for (const route of routes) {
      const url = routeUrl(s.base, route);
      if (url === undefined) continue;
      const key = `${route.method} ${url}`;
      if (slots.has(key)) continue;
      const before = known.get(key);
      slots.set(key, {
        key,
        method: route.method,
        url,
        paths: routePaths(route),
        item: before?.item,
        failure: before?.failure,
      });
    }
    return [...slots.values()];
  }

  async #refreshTarget(t: Slot): Promise<boolean> {
    const result = await probeRoute(t.method, t.url, this.#context());
    if (this.#stopping.signal.aborted) return false;
    const ok = this.#applyRoute(t, result, new Date());
    this.#rebuild();
    return ok;
  }

  /** Keeps the item when the probe failed or described another route, so that only a probe that worked ever changes it */
  #applyRoute(slot: Slot, result: RouteProbe, at: Date): boolean {
    const reason = result.ok ? checkResourcePath(result.route.url, slot.paths) : result.reason;
    if (result.ok && reason === undefined) {
      if (slot.failure !== undefined) this.#log(`${slot.key} answers again`);
      slot.item = itemOf(result.route, at);
      slot.failure = undefined;
      return true;
    }
    if (slot.failure !== reason) this.#log(`${slot.key} failed its probe (${reason})`);
    slot.failure = reason;
    return false;
  }

  /** The services in order, then the targets, and the first of two items for the same method and resource wins */
  #rebuild(): void {
    const seen = new Set<string>();
    const items: DiscoveryResource[] = [];
    const slots = [...this.#services.flatMap((s) => s.slots), ...this.#targets];
    for (const { method, item } of slots) {
      if (item === undefined) continue;
      const id = `${method} ${item.resource}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
    this.#items = items;
  }
}
