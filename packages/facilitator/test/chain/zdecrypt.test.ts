import { afterAll, describe, expect, test } from "vitest";
import { zdecryptArgs, zdecryptDecrypt, zdecryptOwns, ZdecryptError } from "../../src/chain/zdecrypt.js";
import { FakeBinaries } from "../support/fakeZdecrypt.js";
import { KAGE_MEMO, KAGE_TXID, keys, minedFixture, PAYWALL_TXID, ZDECRYPT_BIN } from "../support/fixtures.js";

const fakes = new FakeBinaries();
afterAll(() => fakes.dispose());

const merchant = { bin: ZDECRYPT_BIN, key: keys.merchant.uivk, network: "testnet" } as const;

describe("zdecryptDecrypt", () => {
  test("decrypts the synthetic deposit", async () => {
    const report = await zdecryptDecrypt({
      ...merchant,
      rawHex: keys.deposit.hex,
      at: { tip: keys.deposit.tip },
      payTo: keys.merchant.address,
    });
    expect(report).toMatchObject({
      txid: keys.deposit.txid,
      version: 6,
      expiryHeight: 4547450,
      transparentIn: 0,
      transparentOut: 0,
    });
    expect(report.outputs).toMatchObject([
      { pool: "ironwood", valueZat: 100000, scope: "external", toPayTo: true, memoText: keys.deposit.memo },
    ]);
  });

  test("reads a mined real transaction at its height", async () => {
    const { height, hex } = minedFixture(KAGE_TXID);
    const report = await zdecryptDecrypt({ ...merchant, key: keys.publishedX402Uivk, rawHex: hex, at: { height } });
    expect(report.txid).toBe(KAGE_TXID);
    expect(report.outputs).toEqual([
      { pool: "ironwood", scope: "external", valueZat: 100000, memoKind: "text", memoText: KAGE_MEMO },
    ]);
  });

  test("counts a transparent output", async () => {
    const { height, hex } = minedFixture(PAYWALL_TXID);
    const report = await zdecryptDecrypt({ ...merchant, key: keys.publishedPaywallUivk, rawHex: hex, at: { height } });
    expect([report.transparentIn, report.transparentOut]).toEqual([0, 1]);
  });

  test("counts a transparent input", async () => {
    const report = await zdecryptDecrypt({ ...merchant, rawHex: keys.funding.hex, at: { tip: keys.deposit.tip } });
    expect([report.transparentIn, report.transparentOut]).toEqual([1, 0]);
    expect(report.outputs).toMatchObject([{ pool: "sapling", valueZat: 20000, memoText: "z402 sapling check" }]);
  });

  test("garbage hex is a ZdecryptError", async () => {
    const attempt = zdecryptDecrypt({ ...merchant, rawHex: "deadbeef", at: { tip: 1 }, payTo: keys.merchant.address });
    await expect(attempt).rejects.toThrow(/does not parse/);
    await expect(attempt).rejects.toBeInstanceOf(ZdecryptError);
  });

  test("a key from another network is refused without echoing it", async () => {
    const attempt = zdecryptDecrypt({ ...merchant, network: "regtest", rawHex: keys.deposit.hex, at: { tip: 1 } });
    await expect(attempt).rejects.toThrow(/not a regtest unified/);
    await expect(attempt).rejects.not.toThrow(keys.merchant.uivk.slice(12, 60));
  });

  test("passes the key only in ZDECRYPT_KEY, with PATH as the only other variable", async () => {
    const spy = fakes.recording(ZDECRYPT_BIN);
    const report = await zdecryptDecrypt({
      ...merchant,
      bin: spy.bin,
      rawHex: keys.deposit.hex,
      at: { tip: 4547329 },
      payTo: keys.merchant.address,
    });
    expect(report.outputs).toHaveLength(1);
    expect(spy.calls()).toMatchObject([
      {
        argv: ["decrypt", "--tip", "4547329", "--pay-to", keys.merchant.address, "--network", "testnet"],
        envKeys: ["PATH", "ZDECRYPT_KEY"],
      },
    ]);
  });
});

describe("zdecryptArgs", () => {
  test("args never carry the key", () => {
    expect(zdecryptArgs({ tip: 1 }, keys.merchant.address)).toEqual([
      "decrypt",
      "--tip",
      "1",
      "--pay-to",
      keys.merchant.address,
    ]);
  });

  test("a mined transaction is given by height and needs no payTo", () => {
    expect(zdecryptArgs({ height: 4521112 })).toEqual(["decrypt", "--height", "4521112"]);
  });
});

describe("zdecryptOwns", () => {
  test("the merchant key owns the merchant address", async () => {
    await expect(zdecryptOwns({ ...merchant, address: keys.merchant.address })).resolves.toEqual({
      ownedByKey: true,
      hasTransparent: false,
    });
  });

  test("another key does not own it", async () => {
    await expect(
      zdecryptOwns({ ...merchant, key: keys.publishedX402Uivk, address: keys.merchant.address }),
    ).resolves.toEqual({ ownedByKey: false, hasTransparent: false });
  });

  test("a key from another network is refused", async () => {
    const attempt = zdecryptOwns({ ...merchant, network: "mainnet", address: keys.merchant.address });
    await expect(attempt).rejects.toThrow(/not a mainnet unified/);
    await expect(attempt).rejects.toBeInstanceOf(ZdecryptError);
  });
});
