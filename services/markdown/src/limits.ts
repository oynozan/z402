import ipaddr from "ipaddr.js";

const MINUTE_MS = 60_000;

/**
 * A token bucket per client: `perMinute` tokens at most, refilled continuously. A bucket idle for a minute is full
 * again, so it is forgotten (checked at most once a minute).
 */
export class RateLimiter {
  readonly #perMinute: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  #swept = 0;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  /** 0 when `client` may spend a token now, else the milliseconds until it may */
  wait(client: string): number {
    const tokens = this.#tokens(client, this.#now());
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * MINUTE_MS) / this.#perMinute);
  }

  take(client: string): void {
    const now = this.#now();
    this.#buckets.set(client, { tokens: this.#tokens(client, now) - 1, at: now });
    if (now - this.#swept >= MINUTE_MS) {
      this.#swept = now;
      for (const [key, bucket] of this.#buckets) if (now - bucket.at >= MINUTE_MS) this.#buckets.delete(key);
    }
  }

  #tokens(client: string, now: number): number {
    const bucket = this.#buckets.get(client);
    if (bucket === undefined) return this.#perMinute;
    return Math.min(this.#perMinute, bucket.tokens + ((now - bucket.at) * this.#perMinute) / MINUTE_MS);
  }
}

/**
 * The rate limit key of a client address: an IPv4 address as itself (also when it arrives IPv4-mapped), an IPv6
 * address by its /64, since one IPv6 client usually holds a whole /64.
 */
export function clientKey(address: string | undefined): string {
  if (address === undefined || address === "") return "unknown";
  try {
    const ip = ipaddr.process(address);
    if (ip instanceof ipaddr.IPv4) return ip.toString();
    return `${ip.parts
      .slice(0, 4)
      .map((part) => part.toString(16))
      .join(":")}::/64`;
  } catch {
    return address;
  }
}

/**
 * Entries live `ttlMs` from when they were stored. Past `max` entries or `maxBytes` in all, the oldest go; the newest
 * entry always stays, so that a page just fetched is there for its paid retry.
 */
export class PageCache<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { value: T; bytes: number; until: number }>();
  #bytes = 0;

  constructor(o: { ttlMs: number; max: number; maxBytes: number; now?: () => number }) {
    this.#ttlMs = o.ttlMs;
    this.#max = o.max;
    this.#maxBytes = o.maxBytes;
    this.#now = o.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.until <= this.#now()) {
      this.#delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    this.#delete(key);
    this.#entries.set(key, { value, bytes, until: this.#now() + this.#ttlMs });
    this.#bytes += bytes;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size === 1 || (this.#entries.size <= this.#max && this.#bytes <= this.#maxBytes)) break;
      this.#delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }
}
