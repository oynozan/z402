import { describe, expect, it } from "vitest";
import { FLAG_DEFAULTS, FlagError } from "../src/flags.js";
import { createZcashClient, preflight, PREFLIGHT_FLOOR_ZAT, PreflightError } from "../src/zcash.js";

const walletHolding = (zat: bigint) => ({ spendableBalance: async () => zat });

describe("preflight", () => {
  it("needs two deposit windows of 100,000 zat plus Zallet's worst observed fee of 25,000 each", () => {
    expect(PREFLIGHT_FLOOR_ZAT).toBe(250_000n);
  });

  it("passes at exactly the floor and returns the balance", async () => {
    await expect(preflight(walletHolding(250_000n))).resolves.toBe(250_000n);
    await expect(preflight(walletHolding(10_000_000n))).resolves.toBe(10_000_000n);
  });

  it("refuses one zat below the floor, with both numbers in the message", async () => {
    const refused = preflight(walletHolding(249_999n));
    await expect(refused).rejects.toBeInstanceOf(PreflightError);
    await expect(refused).rejects.toThrow(/249,999 zat.*250,000 zat/);
  });

  it("refuses an empty wallet", async () => {
    await expect(preflight(walletHolding(0n))).rejects.toThrow(/0 zat.*250,000 zat/);
  });

  it("turns a wallet failure into a PreflightError that names the cause", async () => {
    const wallet = {
      spendableBalance: async (): Promise<bigint> => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:50232");
      },
    };
    const refused = preflight(wallet);
    await expect(refused).rejects.toBeInstanceOf(PreflightError);
    await expect(refused).rejects.toThrow(/cannot read the spendable balance.*ECONNREFUSED/);
  });
});

describe("createZcashClient", () => {
  it("rejects --wallet zingo before touching any endpoint", async () => {
    const refused = createZcashClient({ ...FLAG_DEFAULTS, wallet: "zingo" }, () => {});
    await expect(refused).rejects.toBeInstanceOf(FlagError);
    await expect(refused).rejects.toThrow("zingo-cli wallet arrives in Phase 2 (mainnet)");
  });
});
