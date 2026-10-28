import { describe, expect, test } from "vitest";
import { providerId } from "../../src/providers/id.js";

const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const TESTNET_PAY_TO = `utest1${"q".repeat(60)}`;

describe("providerId", () => {
  test("is the first 16 hex of sha256 over the domain tag, the network and payTo, one per line", () => {
    // Each value is `printf 'z402-provider-v1\n<network>\n<payTo>' | shasum -a 256 | cut -c1-16`
    expect(providerId("zcash:regtest", PAY_TO)).toBe("f93eeecbf393ea04");
    expect(providerId("zcash:regtest", OTHER_PAY_TO)).toBe("0f1e689e20871dd9");
    expect(providerId("zcash:testnet", TESTNET_PAY_TO)).toBe("ef37610a46f32076");
  });

  test("the same payTo on another network is another provider", () => {
    expect(providerId("zcash:testnet", PAY_TO)).toBe("eabdd6c3efdcd112");
    expect(providerId("zcash:testnet", PAY_TO)).not.toBe(providerId("zcash:regtest", PAY_TO));
  });

  test("is fixed by the network and payTo alone", () => {
    expect(providerId("zcash:regtest", PAY_TO)).toBe(providerId("zcash:regtest", PAY_TO));
    expect(providerId("zcash:regtest", PAY_TO)).not.toBe(providerId("zcash:regtest", OTHER_PAY_TO));
  });

  test("is 16 lowercase hex characters", () => {
    expect(providerId("zcash:regtest", PAY_TO)).toMatch(/^[0-9a-f]{16}$/);
  });
});
