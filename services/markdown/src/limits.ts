import ipaddr from "ipaddr.js";

const MINUTE_MS = 60_000;

/** Clients the rate limit remembers at most, about 15 MB of buckets */
export const MAX_CLIENTS = 100_000;

/**
 * A token bucket per client: `perMinute` tokens at most, refilled continuously. A bucket idle for a minute is full
 * again, so it is forgotten. Past `maxClients` buckets the one used least recently goes too: an IPv6 sender can be a
 * new client with every request, and forgetting a bucket only gives that client its full allowance back.
 */
export class RateLimiter {
  readonly #perMinute: number;
  readonly #now: () => number;
  readonly #maxClients: number;
  /** In the order of their last take, oldest first */
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(perMinute: number, now: () => number = Date.now, maxClients = MAX_CLIENTS) {
    this.#perMinute = perMinute;
    this.#now = now;
    this.#maxClients = maxClients;
  }

  /** Clients with a bucket */
  get size(): number {
    return this.#buckets.size;
  }

  /** 0 when `client` may spend a token now, else the milliseconds until it may */
  wait(client: string): number {
    const tokens = this.#tokens(client, this.#now());
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * MINUTE_MS) / this.#perMinute);
  }

  take(client: string): void {
    const now = this.#now();
    const tokens = this.#tokens(client, now) - 1;
    this.#buckets.delete(client);
    this.#buckets.set(client, { tokens, at: now });
    for (const [key, bucket] of this.#buckets) {
      if (this.#buckets.size <= this.#maxClients && now - bucket.at < MINUTE_MS) break;
      this.#buckets.delete(key);
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

/** Pages one client's unpaid attempts hold at once for their paid retries */
export const HOLDS_PER_CLIENT = 4;
/** Clients holding pages at once; past it the one that held a page least recently lets go */
export const MAX_HOLDING_CLIENTS = 10_000;

interface Entry<T> {
  key: string;
  value: T;
  bytes: number;
  storedAt: number;
  /** Client to the time until which it holds this page for its paid retry */
  holds: Map<string, number>;
}

/**
 * Pages by URL, kept for the paid retry of every unpaid attempt they answered: that retry is served from here and must
 * never fetch again, since a refusal after the voucher is counted as paid (design §3.4).
 *
 * A page is fresh for `ttlMs` after it was stored, and only a fresh page answers an unpaid attempt. Answering one holds
 * the page for that client for `ttlMs` more, during which paid requests are still answered from it. Past `max` pages
 * or `maxBytes` in all, the oldest pages nobody holds go. A page that does not fit next to the held ones is not stored,
 * which the caller refuses before payment; a client holds HOLDS_PER_CLIENT pages at most, so that it takes many clients
 * to fill the cache. With nothing held, the page stored last stays however large it is.
 */
export class PageCache<T> {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #maxClients: number;
  /** In the order they were stored, oldest first */
  readonly #entries = new Map<string, Entry<T>>();
  /** Client to the keys it holds, oldest first; clients in the order they last held a page */
  readonly #clients = new Map<string, string[]>();
  #bytes = 0;

  constructor(o: { ttlMs: number; max: number; maxBytes: number; now?: () => number; maxClients?: number }) {
    this.#ttlMs = o.ttlMs;
    this.#max = o.max;
    this.#maxBytes = o.maxBytes;
    this.#now = o.now ?? Date.now;
    this.#maxClients = o.maxClients ?? MAX_HOLDING_CLIENTS;
  }

  /** A fresh page, which may answer an unpaid attempt */
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#fresh(entry, now)) return entry.value;
    if (!this.#held(entry, now)) this.#delete(entry);
    return undefined;
  }

  /** A fresh page or a held one, which may answer a paid request */
  getPaid(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (this.#fresh(entry, now) || this.#held(entry, now)) return entry.value;
    this.#delete(entry);
    return undefined;
  }

  /** Holds a stored page for the paid retry of `client`, from now for `ttlMs` */
  hold(key: string, client: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    entry.holds.set(client, this.#now() + this.#ttlMs);
    const keys = (this.#clients.get(client) ?? []).filter((k) => k !== entry.key);
    keys.push(entry.key);
    for (const dropped of keys.splice(0, Math.max(0, keys.length - HOLDS_PER_CLIENT))) {
      this.#entries.get(dropped)?.holds.delete(client);
    }
    this.#clients.delete(client);
    this.#clients.set(client, keys);
    for (const [oldest, held] of this.#clients) {
      if (this.#clients.size <= this.#maxClients) break;
      for (const k of held) this.#entries.get(k)?.holds.delete(oldest);
      this.#clients.delete(oldest);
    }
  }

  /** Whether a page for `key` could be stored at all next to the held ones, a copy of which it would replace */
  hasRoom(key: string): boolean {
    const now = this.#now();
    this.#expire(now);
    const held = this.#heldTotals(now, this.#entries.get(key));
    return held.count < this.#max && held.bytes < this.#maxBytes;
  }

  /** Stores a page and returns true, or returns false when it does not fit next to the held pages, which all stay */
  set(key: string, value: T, bytes: number): boolean {
    const now = this.#now();
    this.#expire(now);
    const old = this.#entries.get(key);
    const held = this.#heldTotals(now, old);
    if (held.count > 0 && (held.count + 1 > this.#max || held.bytes + bytes > this.#maxBytes)) return false;
    // Fetched again: whoever held the old copy holds this one
    const entry: Entry<T> = { key: old?.key ?? key, value, bytes, storedAt: now, holds: old?.holds ?? new Map() };
    if (old !== undefined) {
      this.#entries.delete(key);
      this.#bytes -= old.bytes;
    }
    this.#entries.set(entry.key, entry);
    this.#bytes += bytes;
    for (const other of this.#entries.values()) {
      if (this.#entries.size <= this.#max && this.#bytes <= this.#maxBytes) break;
      if (other !== entry && !this.#held(other, now)) this.#delete(other);
    }
    return true;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  #fresh(entry: Entry<T>, now: number): boolean {
    return now - entry.storedAt < this.#ttlMs;
  }

  #held(entry: Entry<T>, now: number): boolean {
    for (const until of entry.holds.values()) if (until > now) return true;
    return false;
  }

  #heldTotals(now: number, except: Entry<T> | undefined): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const entry of this.#entries.values()) {
      if (entry === except || !this.#held(entry, now)) continue;
      count += 1;
      bytes += entry.bytes;
    }
    return { count, bytes };
  }

  /** Drops the pages that are neither fresh nor held; the fresh ones are the newest */
  #expire(now: number): void {
    for (const entry of this.#entries.values()) {
      if (this.#fresh(entry, now)) break;
      if (!this.#held(entry, now)) this.#delete(entry);
    }
  }

  #delete(entry: Entry<T>): void {
    this.#entries.delete(entry.key);
    this.#bytes -= entry.bytes;
    for (const client of entry.holds.keys()) {
      const keys = this.#clients.get(client)?.filter((k) => k !== entry.key);
      if (keys === undefined) continue;
      if (keys.length === 0) this.#clients.delete(client);
      else this.#clients.set(client, keys);
    }
  }
}
