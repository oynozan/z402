import type { LightwalletdClient, RawTx } from "@z402/lightwalletd";
import {
  ChainUnavailableError,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  type ZcashNetwork,
} from "@z402/protocol";
import { afterAll, describe, expect, test } from "vitest";
import { LightwalletdChainView } from "../../src/chain/lightwalletdChainView.js";
import { ZdecryptError } from "../../src/chain/zdecrypt.js";
import { FakeBinaries } from "../support/fakeZdecrypt.js";
import { failure } from "../support/failure.js";
import {
  hexBytes,
  keys,
  minedFixture,
  PAYWALL_MEMO,
  PAYWALL_TXID,
  ZDECRYPT_BIN,
} from "../support/fixtures.js";

const fakes = new FakeBinaries();
afterAll(() => fakes.dispose());

type Lwd = Pick<LightwalletdClient, "getTip" | "getTransaction">;

const DEPOSIT_TIP = 4_547_329;

const inMempool = (hex: string): RawTx => ({ found: true, raw: hexBytes(hex), location: "mempool", height: null });
const inBlock = (hex: string, height: number): RawTx => ({
  found: true,
  raw: hexBytes(hex),
  location: "mined",
  height,
});

/** A lightwalletd that answers with one fixed transaction and remembers what it was asked */
function fakeLwd(tx: RawTx, tip = DEPOSIT_TIP) {
  const lwd = {
    tipCalls: 0,
    asked: [] as string[],
    async getTip() {
      lwd.tipCalls++;
      return tip;
    },
    async getTransaction(txid: string) {
      lwd.asked.push(txid);
      return tx;
    },
  };
  return lwd;
}

function merchantView(lwd: Lwd, zdecryptBin: string, o: { uivk?: string; payTo?: string } = {}) {
  return new LightwalletdChainView({
    lwd,
    zdecryptBin,
    uivk: o.uivk ?? keys.merchant.uivk,
    payTo: o.payTo ?? keys.merchant.address,
    network: NETWORK_TESTNET,
  });
}

describe("LightwalletdChainView.inspect", () => {
  test("a mempool deposit is read at the tip", async () => {
    const lwd = fakeLwd(inMempool(keys.deposit.hex));
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).resolves.toEqual({
      found: true,
      txid: keys.deposit.txid,
      location: "mempool",
      minedHeight: null,
      expiryHeight: 4547450,
      hasTransparent: false,
      outputs: [{ pool: "ironwood", valueZat: 100000n, memo: keys.deposit.memo }],
    });
    expect(lwd.asked).toEqual([keys.deposit.txid]);
    expect(lwd.tipCalls).toBe(1);
    expect(zd.calls().map((c) => c.argv)).toEqual([
      ["decrypt", "--tip", "4547329", "--pay-to", keys.merchant.address, "--network", "testnet"],
    ]);
  });

  test("a mined deposit is read at its block height", async () => {
    const lwd = fakeLwd(inBlock(keys.deposit.hex, 4_547_300), 9_999_999);
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).resolves.toMatchObject({
      found: true,
      location: "mined",
      minedHeight: 4_547_300,
      outputs: [{ pool: "ironwood", valueZat: 100000n, memo: keys.deposit.memo }],
    });
    expect(lwd.tipCalls).toBe(0);
    expect(zd.calls().map((c) => c.argv)).toEqual([
      ["decrypt", "--height", "4547300", "--pay-to", keys.merchant.address, "--network", "testnet"],
    ]);
  });

  test("an orphaned deposit is read at the tip and has no mined height", async () => {
    const lwd = fakeLwd({ found: true, raw: hexBytes(keys.deposit.hex), location: "orphaned", height: null });
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).resolves.toMatchObject({
      found: true,
      location: "orphaned",
      minedHeight: null,
      outputs: [{ pool: "ironwood", valueZat: 100000n, memo: keys.deposit.memo }],
    });
    expect(zd.calls().map((c) => c.argv.slice(0, 3))).toEqual([["decrypt", "--tip", "4547329"]]);
  });

  test("an unknown transaction is a definitive not-found", async () => {
    const lwd = fakeLwd({ found: false });
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).resolves.toEqual({ found: false });
    expect(zd.calls()).toEqual([]);
  });

  test("bytes of another transaction are not trusted", async () => {
    const lwd = fakeLwd(inMempool(keys.funding.hex));
    const attempt = merchantView(lwd, ZDECRYPT_BIN).inspect(keys.deposit.txid);
    await expect(attempt).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(attempt).rejects.toThrow(/does not match/);
  });

  test("a transparent output marks the deposit transparent", async () => {
    const { height, hex } = minedFixture(PAYWALL_TXID);
    const view = new LightwalletdChainView({
      lwd: fakeLwd(inBlock(hex, height)),
      zdecryptBin: ZDECRYPT_BIN,
      uivk: keys.publishedPaywallUivk,
      payTo: keys.publishedPaywallAddress,
      network: NETWORK_TESTNET,
    });
    await expect(view.inspect(PAYWALL_TXID)).resolves.toMatchObject({
      hasTransparent: true,
      minedHeight: 4522621,
      outputs: [{ pool: "ironwood", valueZat: 10000n, memo: PAYWALL_MEMO }],
    });
  });

  test("a transparent input marks the deposit transparent", async () => {
    const lwd = fakeLwd(inMempool(keys.funding.hex));
    await expect(merchantView(lwd, ZDECRYPT_BIN).inspect(keys.funding.txid)).resolves.toMatchObject({
      hasTransparent: true,
      outputs: [{ pool: "sapling", valueZat: 20000n, memo: "z402 sapling check" }],
    });
  });

  test("an internal-scope output is not a payment to the merchant", async () => {
    const lwd = fakeLwd(inMempool(keys.deposit.hex));
    const view = merchantView(lwd, ZDECRYPT_BIN, { uivk: keys.agentUfvk });
    await expect(view.inspect(keys.deposit.txid)).resolves.toMatchObject({ found: true, outputs: [] });
  });

  test("an output to another address of the same key is not a payment to payTo", async () => {
    const lwd = fakeLwd(inMempool(keys.deposit.hex));
    const view = merchantView(lwd, ZDECRYPT_BIN, { payTo: keys.merchant.orchardOnlyAddress });
    await expect(view.inspect(keys.deposit.txid)).resolves.toMatchObject({ found: true, outputs: [] });
  });
});

describe("LightwalletdChainView.inspect failures", () => {
  test("a key from another network is refused without echoing it", async () => {
    const view = new LightwalletdChainView({
      lwd: fakeLwd(inMempool(keys.deposit.hex)),
      zdecryptBin: ZDECRYPT_BIN,
      uivk: keys.merchant.uivk,
      payTo: keys.merchant.address,
      network: NETWORK_REGTEST,
    });
    const error = await failure(view.inspect(keys.deposit.txid));
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect(error.message).toMatch(/not a regtest unified/);
    expect(error.message).not.toContain(keys.merchant.uivk.slice(12, 60));
  });

  test("bytes zdecrypt cannot parse are an outage, not an answer", async () => {
    const lwd = fakeLwd(inMempool("deadbeef"));
    const error = await failure(merchantView(lwd, ZDECRYPT_BIN).inspect(keys.deposit.txid));
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect(error.message).toMatch(/does not parse/);
    expect(error.cause).toBeInstanceOf(ZdecryptError);
  });

  test("a mined transaction without a height is an outage", async () => {
    const lwd = fakeLwd({ found: true, raw: hexBytes(keys.deposit.hex), location: "mined", height: null });
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(zd.calls()).toEqual([]);
  });

  test("a lightwalletd outage is never turned into an answer", async () => {
    const outage = new ChainUnavailableError("lightwalletd GetTransaction failed: unavailable");
    const lwd = {
      async getTip() {
        return DEPOSIT_TIP;
      },
      async getTransaction(): Promise<RawTx> {
        throw outage;
      },
    };
    await expect(merchantView(lwd, ZDECRYPT_BIN).inspect(keys.deposit.txid)).rejects.toBe(outage);
  });

  test("a tip outage while reading a mempool deposit is not an answer either", async () => {
    const outage = new ChainUnavailableError("lightwalletd GetLatestBlock failed: unavailable");
    const lwd = {
      async getTip(): Promise<number> {
        throw outage;
      },
      async getTransaction() {
        return inMempool(keys.deposit.hex);
      },
    };
    const zd = fakes.recording(ZDECRYPT_BIN);
    await expect(merchantView(lwd, zd.bin).inspect(keys.deposit.txid)).rejects.toBe(outage);
    expect(zd.calls()).toEqual([]);
  });

  test.each(["", "AB".repeat(32), ` ${"ab".repeat(32)}`, "ab".repeat(31)])(
    "the txid %j is refused before any lookup",
    async (bad) => {
      const lwd = fakeLwd({ found: false });
      await expect(merchantView(lwd, ZDECRYPT_BIN).inspect(bad)).rejects.toBeInstanceOf(TypeError);
      expect(lwd.asked).toEqual([]);
    },
  );
});

describe("LightwalletdChainView with a scripted zdecrypt", () => {
  const TXID = "cd".repeat(32);
  const PAY_TO = "utest1payto";
  const report = (outputs: object[]) =>
    JSON.stringify({ txid: TXID, version: 6, expiryHeight: 500, transparentIn: 0, transparentOut: 0, outputs });
  const paid = (change: object) => ({
    pool: "ironwood",
    scope: "external",
    valueZat: 100,
    memoKind: "text",
    memoText: "m:0",
    toPayTo: true,
    ...change,
  });
  const viewOver = (zdecryptBin: string, network: ZcashNetwork = NETWORK_TESTNET) =>
    new LightwalletdChainView({
      lwd: fakeLwd(inMempool("00")),
      zdecryptBin,
      uivk: "uivktest1scripted",
      payTo: PAY_TO,
      network,
    });

  test("keeps external outputs to payTo and surfaces only text memos", async () => {
    const zd = fakes.canned(
      report([
        paid({ valueZat: 100, memoText: "kept:0" }),
        paid({ valueZat: 200, scope: "internal" }),
        paid({ valueZat: 300, toPayTo: false }),
        paid({ valueZat: 400, toPayTo: undefined }),
        paid({ valueZat: 500, pool: "sapling", memoKind: "empty", memoText: null }),
        paid({ valueZat: 600, pool: "orchard", memoKind: "binary", memoText: "ignored" }),
      ]),
    );
    await expect(viewOver(zd.bin).inspect(TXID)).resolves.toMatchObject({
      outputs: [
        { pool: "ironwood", valueZat: 100n, memo: "kept:0" },
        { pool: "sapling", valueZat: 500n, memo: null },
        { pool: "orchard", valueZat: 600n, memo: null },
      ],
    });
  });

  test.each([
    [NETWORK_REGTEST, "regtest"],
    [NETWORK_TESTNET, "testnet"],
    [NETWORK_MAINNET, "mainnet"],
  ] as const)("%s is given to zdecrypt as --network %s", async (network, bare) => {
    const zd = fakes.canned(report([]));
    await viewOver(zd.bin, network).inspect(TXID);
    expect(zd.calls().map((c) => c.argv.slice(-2))).toEqual([["--network", bare]]);
  });

  test("a network that is not a Zcash network is refused when the view is built", () => {
    expect(() => viewOver("unused", "zcash:signet" as ZcashNetwork)).toThrow(TypeError);
  });

  test("tip is the lightwalletd tip", async () => {
    const view = merchantView(fakeLwd({ found: false }, 4_547_999), ZDECRYPT_BIN);
    await expect(view.tip()).resolves.toBe(4_547_999);
  });
});
