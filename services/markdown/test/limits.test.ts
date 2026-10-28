import { describe, expect, test } from "vitest";
import { clientKey, PageCache, RateLimiter } from "../src/limits.js";

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
});
