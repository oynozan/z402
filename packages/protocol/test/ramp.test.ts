import { describe, expect, it } from "vitest";
import {
  checkVoucher,
  computeLimit,
  confirmations,
  DEMO_TERMS,
  isDepositDead,
  zeroConfEligible,
  type DepositStatus,
  type RampDeposit,
} from "../src/index.js";

const W = 100000n;

function d(valueZat: bigint, status: DepositStatus, zeroConf = true): RampDeposit {
  return { valueZat, status, zeroConf };
}

describe("computeLimit", () => {
  const cases: Array<[string, RampDeposit[], bigint]> = [
    ["new session", [], 0n],
    ["D1 pending", [d(W, "pending")], 100000n],
    ["D1 confirmed", [d(W, "confirmed")], 125000n],
    ["D1 confirmed + D2 pending", [d(W, "confirmed"), d(W, "pending")], 225000n],
    ["D1 final + D2 confirmed", [d(W, "final"), d(W, "confirmed")], 250000n],
    ["two pending (window cap)", [d(W, "pending"), d(W, "pending")], 100000n],
    ["8 confirmed (credit at cap)", Array.from({ length: 8 }, () => d(W, "confirmed")), 1000000n],
    ["100001 confirmed (floor)", [d(100001n, "confirmed")], 125001n],
    ["1000000 pending (over-deposit)", [d(1000000n, "pending")], 100000n],
    ["orphaned and dead count nowhere", [d(W, "orphaned"), d(W, "dead")], 0n],
    ["pending without zero-conf", [d(W, "pending", false)], 0n],
  ];

  it.each(cases)("%s", (_name, deposits, limitZat) => {
    expect(computeLimit(deposits, DEMO_TERMS).limitZat).toBe(limitZat);
  });

  it("breaks the limit into its three parts", () => {
    expect(computeLimit([d(W, "confirmed"), d(W, "pending")], DEMO_TERMS)).toEqual({
      confirmedZat: 100000n,
      pendingZat: 100000n,
      creditZat: 25000n,
      limitZat: 225000n,
    });
  });

  it("floors the credit ratio", () => {
    expect(computeLimit([d(3n, "confirmed")], { ...DEMO_TERMS, creditRatioBps: 3333 }).creditZat).toBe(0n);
    expect(computeLimit([d(100001n, "confirmed")], DEMO_TERMS).creditZat).toBe(25000n);
  });

  it("caps credit at creditCapZat", () => {
    expect(computeLimit([d(10000000n, "final")], DEMO_TERMS).creditZat).toBe(200000n);
  });

  it("sums pending zero-conf deposits before applying the window cap, skipping non-zero-conf ones", () => {
    const ramp = computeLimit([d(60000n, "pending"), d(60000n, "pending", false), d(30000n, "pending")], DEMO_TERMS);
    expect(ramp.pendingZat).toBe(90000n);
    expect(ramp.limitZat).toBe(90000n);
  });

  it("does not mix amounts above Number.MAX_SAFE_INTEGER", () => {
    const big = 2_000_000_000_000_000n;
    const ramp = computeLimit([d(big, "confirmed")], DEMO_TERMS);
    expect(ramp.confirmedZat).toBe(big);
    expect(ramp.creditZat).toBe(200000n);
    expect(ramp.limitZat).toBe(big + 200000n);
  });
});

describe("confirmations", () => {
  it("counts the mined block as the first confirmation", () => {
    expect(confirmations(100, 100)).toBe(1);
  });

  it("clamps a mined height ahead of the cached tip", () => {
    expect(confirmations(100, 99)).toBe(1);
  });

  it("grows with the tip", () => {
    expect(confirmations(100, 109)).toBe(10);
  });
});

describe("isDepositDead", () => {
  it("is alive one block before expiry", () => {
    expect(isDepositDead({ minedHeight: null, expiryHeight: 200, tip: 199 })).toBe(false);
  });

  it("is dead exactly at tip >= expiryHeight", () => {
    expect(isDepositDead({ minedHeight: null, expiryHeight: 200, tip: 200 })).toBe(true);
    expect(isDepositDead({ minedHeight: null, expiryHeight: 200, tip: 201 })).toBe(true);
  });

  it("never expires with expiryHeight 0", () => {
    expect(isDepositDead({ minedHeight: null, expiryHeight: 0, tip: 999 })).toBe(false);
  });

  it("is never dead once mined", () => {
    expect(isDepositDead({ minedHeight: 150, expiryHeight: 200, tip: 300 })).toBe(false);
  });
});

describe("zeroConfEligible", () => {
  const base = { valueZat: W, expiryHeight: 1020, referenceTip: 1000, terms: DEMO_TERMS };

  it("accepts exactly zeroConfMinExpiryBlocks of margin", () => {
    expect(zeroConfEligible(base)).toBe(true);
  });

  it("rejects one block short", () => {
    expect(zeroConfEligible({ ...base, expiryHeight: 1019 })).toBe(false);
  });

  it("accepts expiryHeight 0 (no expiry)", () => {
    expect(zeroConfEligible({ ...base, expiryHeight: 0 })).toBe(true);
  });

  it("rejects a sub-window value", () => {
    expect(zeroConfEligible({ ...base, valueZat: 99999n })).toBe(false);
  });

  it("accepts an over-window value", () => {
    expect(zeroConfEligible({ ...base, valueZat: 1000000n })).toBe(true);
  });
});

describe("checkVoucher", () => {
  const base = { cLast: 1000n, price: 500n, limit: 100000n };

  it("accepts an exact increment", () => {
    expect(checkVoucher({ ...base, cNew: 1500n })).toBe("ok");
  });

  it("rejects an increment below the price", () => {
    expect(checkVoucher({ ...base, cNew: 1499n })).toBe("cumulative_mismatch");
  });

  it("accepts cNew equal to the limit (inclusive)", () => {
    expect(checkVoucher({ ...base, cNew: 100000n })).toBe("ok");
  });

  it("rejects cNew above the limit", () => {
    expect(checkVoucher({ ...base, cNew: 100500n })).toBe("over_limit");
  });

  it("reports the mismatch before the limit", () => {
    expect(checkVoucher({ cLast: 1000n, cNew: 1200n, price: 500n, limit: 100n })).toBe("cumulative_mismatch");
  });

  it("accepts an overshoot by more than one price (lenient increment)", () => {
    expect(checkVoucher({ ...base, cNew: 2500n })).toBe("ok");
  });

  it("rejects a decreasing cumulative", () => {
    expect(checkVoucher({ ...base, cNew: 900n })).toBe("cumulative_mismatch");
  });
});
