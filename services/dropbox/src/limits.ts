/**
 * The rate of upload attempts per client. An unpaid attempt costs the server a whole body read and an age check, so
 * each one takes a token from the client's bucket of `perMinute` tokens, which refills continuously. An attempt that
 * passes its checks earns a pass that its paid retry spends instead of a token, so a client within its rate is never
 * refused after paying. A paid attempt without a pass takes a token like any other, or a made-up payment header would
 * be a way around the limit.
 */
import { isIPv4, isIPv6 } from "node:net";

const MINUTE_MS = 60_000;
/** How long a paid retry may take to follow its attempt, a deposit and its confirmation included */
const PASS_MS = 10 * MINUTE_MS;
const MAX_CLIENTS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
  /** Paid retries earned by attempts that passed, good until passesUntil */
  passes: number;
  passesUntil: number;
}

export class AttemptLimiter {
  readonly #perMinute: number;
  readonly #maxClients: number;
  readonly #now: () => number;
  // In the order of their last use, so the first one is the one to forget
  readonly #buckets = new Map<string, Bucket>();

  constructor(o: { perMinute: number; maxClients?: number; now?: () => number }) {
    this.#perMinute = o.perMinute;
    this.#maxClients = o.maxClients ?? MAX_CLIENTS;
    this.#now = o.now ?? Date.now;
  }

  get size(): number {
    return this.#buckets.size;
  }

  /** 0 when the attempt may go on, which spends a pass or a token, else the milliseconds until the next token */
  admit(client: string, paid: boolean): number {
    const bucket = this.#use(client);
    if (paid && bucket.passes > 0) {
      bucket.passes -= 1;
      return 0;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / this.#perMinute);
  }

  /** An unpaid attempt of `client` passed every check, so its paid retry will not take a token */
  passed(client: string): void {
    const bucket = this.#use(client);
    bucket.passes = Math.min(this.#perMinute, bucket.passes + 1);
    bucket.passesUntil = this.#now() + PASS_MS;
  }

  #use(client: string): Bucket {
    const now = this.#now();
    let bucket = this.#buckets.get(client);
    if (bucket === undefined) {
      bucket = { tokens: this.#perMinute, at: now, passes: 0, passesUntil: 0 };
    } else {
      this.#buckets.delete(client);
      const refill = (Math.max(0, now - bucket.at) * this.#perMinute) / MINUTE_MS;
      bucket.tokens = Math.min(this.#perMinute, bucket.tokens + refill);
      bucket.at = now;
      if (now > bucket.passesUntil) bucket.passes = 0;
    }
    this.#buckets.set(client, bucket);
    for (const oldest of this.#buckets.keys()) {
      if (this.#buckets.size <= this.#maxClients) break;
      this.#buckets.delete(oldest);
    }
    return bucket;
  }
}

/** The eight groups of an address that net.isIPv6 accepts */
function groupsOf(address: string): number[] {
  const parse = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = "", tail] = (address.split("%", 1)[0] ?? "").split("::");
  const left = parse(head);
  if (tail === undefined) return left;
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** The bucket of a client address, IPv4 as itself even when it arrives IPv4-mapped, and IPv6 by its /64 */
export function clientKey(address: string | undefined): string {
  if (address === undefined || address === "") return "unknown";
  if (isIPv4(address) || !isIPv6(address)) return address;
  const groups = groupsOf(address);
  if (groups.slice(0, 6).join(":") === "0:0:0:0:0:65535") {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  // One IPv6 client usually holds a whole /64
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
