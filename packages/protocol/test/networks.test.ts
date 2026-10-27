import { describe, expect, it } from "vitest";
import { isZcashNetwork, ZCASH_NETWORKS } from "../src/index.js";

describe("ZCASH_NETWORKS", () => {
  it("lists the three networks in order", () => {
    expect(ZCASH_NETWORKS).toEqual(["zcash:regtest", "zcash:testnet", "zcash:mainnet"]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ZCASH_NETWORKS)).toBe(true);
  });
});

describe("isZcashNetwork", () => {
  it.each(["zcash:regtest", "zcash:testnet", "zcash:mainnet"])("accepts %s", (network) => {
    expect(isZcashNetwork(network)).toBe(true);
  });

  it.each([
    ["a foreign chain id", "eip155:1"],
    ["the empty string", ""],
    ["an Object.prototype member", "toString"],
    ["__proto__", "__proto__"],
    ["a wrong-case id", "ZCASH:REGTEST"],
    ["a number", 123],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(isZcashNetwork(value)).toBe(false);
  });
});
