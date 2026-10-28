import { describe, expect, test } from "vitest";
import { clientKey, HOLDS_PER_CLIENT, MAX_CLIENTS, PageCache, RateLimiter } from "../src/limits.js";

describe("RateLimiter", () => {
  test("a full bucket of perMinute tokens, refilled continuously", () => {
    let now = 0;
    const limiter = new RateLimiter(3, () => now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.wait("a")).toBe(0);
      limiter.take("a");
    }
    // One token comes back every 20 s
    expect(limiter.wait("a")).toBe(20_000);
    expect(limiter.wait("b")).toBe(0);
    now = 15_000;
    expect(limiter.wait("a")).toBe(5_000);
    now = 20_000;
    expect(limiter.wait("a")).toBe(0);
    limiter.take("a");
    expect(limiter.wait("a")).toBe(20_000);
    // Never more than perMinute, however long the client was away
    now = 3_600_000;
    for (let i = 0; i < 3; i += 1) limiter.take("a");
    expect(limiter.wait("a")).toBe(20_000);
  });

  test("a bucket idle for a minute is forgotten", () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    limiter.take("a");
    now = 30_000;
    limiter.take("b");
    now = 60_000;
    limiter.take("c");
    expect(limiter.size).toBe(2);
    expect(limiter.wait("a")).toBe(0);
  });

  test("the buckets stay bounded however many clients arrive within a minute", () => {
    // Each IPv6 /64 is a client of its own, so a sender with a large prefix can bring a new one with every request
    const limiter = new RateLimiter(30, () => 0);
    for (let i = 0; i < MAX_CLIENTS + 50_000; i += 1) {
      limiter.take(`2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`);
    }
    expect(limiter.size).toBe(MAX_CLIENTS);

    // Past the cap the bucket used least recently goes, which only hands that client its full allowance back
    const small = new RateLimiter(1, () => 0, 3);
    for (const client of ["a", "b", "c"]) small.take(client);
    small.take("d");
    expect(small.size).toBe(3);
    expect([small.wait("a"), small.wait("b"), small.wait("d")]).toEqual([0, 60_000, 60_000]);
  });
});

describe("clientKey", () => {
  test("IPv4 as itself, IPv4-mapped as IPv4, IPv6 by its /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("not an ip")).toBe("not an ip");
  });
});

describe("PageCache", () => {
  test("entries expire after ttlMs", () => {
    let now = 0;
    const cache = new PageCache<string>({ ttlMs: 1_000, max: 10, maxBytes: 100, now: () => now });
    cache.set("a", "A", 1);
    now = 999;
    expect(cache.get("a")).toBe("A");
    now = 1_000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test("the oldest go past max entries or maxBytes, and the newest always stays", () => {
    const cache = new PageCache<string>({ ttlMs: 60_000, max: 2, maxBytes: 10, now: () => 0 });
    cache.set("a", "A", 4);
    cache.set("b", "B", 4);
    cache.set("c", "C", 4);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([undefined, "B", "C"]);
    cache.set("d", "D", 7);
    expect([cache.get("b"), cache.get("c"), cache.get("d")]).toEqual([undefined, undefined, "D"]);
    cache.set("huge", "H", 50);
    expect(cache.get("huge")).toBe("H");
    expect([cache.size, cache.bytes]).toEqual([1, 50]);
    // Storing a key again replaces it and counts its bytes once
    cache.set("huge", "H2", 3);
    expect([cache.get("huge"), cache.size, cache.bytes]).toEqual(["H2", 1, 3]);
  });

  test("a page held for a paid retry stays through other traffic, and past its freshness for paid requests", () => {
    let now = 0;
    const cache = new PageCache<string>({ ttlMs: 1_000, max: 2, maxBytes: 100, now: () => now });
    expect(cache.set("a", "A", 10)).toBe(true);
    now = 900;
    // Answered to x's unpaid attempt, so held for its paid retry until 1,900
    cache.hold("a", "x");
    expect(cache.set("b", "B", 10)).toBe(true);
    // Over max: b, the oldest page nobody holds, goes instead of a
    expect(cache.set("c", "C", 10)).toBe(true);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual(["A", undefined, "C"]);
    now = 1_500;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.getPaid("a")).toBe("A");
    now = 1_900;
    expect([cache.getPaid("a"), cache.getPaid("c")]).toEqual([undefined, undefined]);
    expect([cache.size, cache.bytes]).toEqual([0, 0]);
  });

  test("a page that does not fit next to the held ones is not stored", () => {
    const cache = new PageCache<string>({ ttlMs: 1_000, max: 2, maxBytes: 100, now: () => 0 });
    cache.set("a", "A", 10);
    cache.hold("a", "x");
    cache.set("b", "B", 10);
    cache.hold("b", "y");
    expect(cache.hasRoom("c")).toBe(false);
    // A new copy of a held page takes its place, so it needs no more room
    expect(cache.hasRoom("a")).toBe(true);
    expect(cache.set("c", "C", 10)).toBe(false);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual(["A", "B", undefined]);

    const bytes = new PageCache<string>({ ttlMs: 1_000, max: 10, maxBytes: 100, now: () => 0 });
    bytes.set("a", "A", 60);
    bytes.hold("a", "x");
    expect(bytes.hasRoom("b")).toBe(true);
    expect(bytes.set("b", "B", 50)).toBe(false);
    expect(bytes.set("b", "B", 40)).toBe(true);
    bytes.hold("b", "y");
    // A page fetched again keeps the holds on it, and its new copy must fit next to the other held pages
    expect(bytes.set("a", "A2", 70)).toBe(false);
    expect(bytes.get("a")).toBe("A");
    expect(bytes.set("a", "A2", 50)).toBe(true);
    expect(bytes.set("b", "B2", 40)).toBe(true);
    expect([bytes.get("a"), bytes.get("b"), bytes.size, bytes.bytes]).toEqual(["A2", "B2", 2, 90]);
  });

  test("a client holds at most HOLDS_PER_CLIENT pages, so that no client can fill the cache alone", () => {
    const max = HOLDS_PER_CLIENT + 2;
    const cache = new PageCache<string>({ ttlMs: 1_000, max, maxBytes: 1_000, now: () => 0 });
    for (let i = 0; i < max; i += 1) {
      cache.set(`p${i}`, "P", 1);
      cache.hold(`p${i}`, "x");
    }
    // x let go of its two oldest holds, so another client's pages push those out and nothing else
    expect(cache.set("q0", "Q", 1)).toBe(true);
    cache.hold("q0", "y");
    expect(cache.set("q1", "Q", 1)).toBe(true);
    cache.hold("q1", "y");
    expect(cache.set("q2", "Q", 1)).toBe(false);
    expect([cache.get("p0"), cache.get("p1"), cache.get("p2"), cache.get(`p${max - 1}`)]).toEqual([
      undefined,
      undefined,
      "P",
      "P",
    ]);
  });

  test("the clients holding pages are bounded, the oldest letting go first", () => {
    const cache = new PageCache<string>({ ttlMs: 1_000, max: 3, maxBytes: 1_000, now: () => 0, maxClients: 2 });
    for (const [key, client] of [["a", "c1"], ["b", "c2"], ["c", "c3"]] as const) {
      cache.set(key, key.toUpperCase(), 1);
      cache.hold(key, client);
    }
    expect(cache.set("d", "D", 1)).toBe(true);
    expect([cache.get("a"), cache.get("b"), cache.get("c"), cache.get("d")]).toEqual([undefined, "B", "C", "D"]);
  });
});
