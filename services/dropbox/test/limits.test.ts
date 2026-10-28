import { describe, expect, test } from "vitest";
import { AttemptLimiter, clientKey } from "../src/limits.js";

describe("AttemptLimiter", () => {
  test("admits perMinute attempts at once, then says how long until the next token", () => {
    let now = 1_000_000;
    const limiter = new AttemptLimiter({ perMinute: 3, now: () => now });
    for (let i = 0; i < 3; i += 1) expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(20_000);
    now += 5_000;
    expect(limiter.admit("a", false)).toBe(15_000);
    now += 15_000;
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(20_000);
  });

  test("counts every client by itself", () => {
    const limiter = new AttemptLimiter({ perMinute: 1, now: () => 0 });
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("b", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(60_000);
  });

  test("lets the paid retry of an attempt that passed through without a token, once", () => {
    const limiter = new AttemptLimiter({ perMinute: 1, now: () => 0 });
    expect(limiter.admit("a", false)).toBe(0);
    limiter.passed("a");
    expect(limiter.admit("a", true)).toBe(0);
    expect(limiter.admit("a", true)).toBe(60_000);
    expect(limiter.admit("a", false)).toBe(60_000);
  });

  test("keeps a pass for the paid retry, which an unpaid attempt cannot spend", () => {
    const limiter = new AttemptLimiter({ perMinute: 1, now: () => 0 });
    limiter.passed("a");
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(60_000);
    expect(limiter.admit("a", true)).toBe(0);
  });

  test("makes a paid attempt that no passed attempt earned take a token like any other", () => {
    const limiter = new AttemptLimiter({ perMinute: 2, now: () => 0 });
    expect(limiter.admit("a", true)).toBe(0);
    expect(limiter.admit("a", true)).toBe(0);
    expect(limiter.admit("a", true)).toBe(30_000);
  });

  test("keeps no more passes than perMinute, and lets them lapse after ten minutes", () => {
    let now = 0;
    const limiter = new AttemptLimiter({ perMinute: 2, now: () => now });
    for (let i = 0; i < 5; i += 1) limiter.passed("a");
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", true)).toBe(0);
    expect(limiter.admit("a", true)).toBe(0);
    expect(limiter.admit("a", true)).toBe(30_000);

    limiter.passed("a");
    now += 10 * 60_000 + 1;
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("a", true)).toBe(30_000);
  });

  test("keeps at most maxClients buckets, forgetting the one used least recently", () => {
    const limiter = new AttemptLimiter({ perMinute: 1, maxClients: 2, now: () => 0 });
    expect(limiter.admit("a", false)).toBe(0);
    expect(limiter.admit("b", false)).toBe(0);
    expect(limiter.admit("a", false)).toBe(60_000);
    expect(limiter.admit("c", false)).toBe(0);
    expect(limiter.size).toBe(2);
    // a was used after b, so b went and starts again with a full bucket
    expect(limiter.admit("a", false)).toBe(60_000);
    expect(limiter.admit("b", false)).toBe(0);
    expect(limiter.size).toBe(2);
  });
});

describe("clientKey", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::ffff:cb00:7107", "203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:DB8:0001:0002:aaaa::1", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["64:ff9b::198.51.100.1", "64:ff9b:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["not an address", "not an address"],
    ["", "unknown"],
    [undefined, "unknown"],
  ])("%s counts as %s", (address, key) => {
    expect(clientKey(address)).toBe(key);
  });
});
