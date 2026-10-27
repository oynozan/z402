import { status } from "@grpc/grpc-js";
import { ChainUnavailableError } from "@z402/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createLightwalletdClient,
  isDefinitiveNotFound,
  txidToFilterHash,
  type LightwalletdClient,
} from "../src/index.js";
import { startFakeLwd, type FakeLwd, type FakeLwdScript } from "./support/fakeLwd.js";

const txid = (tag: number): string =>
  Buffer.from([tag, ...Array.from({ length: 31 }, (_, i) => i + 1)]).toString("hex");

const TX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const TX_ON_THE_WIRE = "201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a090807060504030201";
const TX_MINED = txid(0x02);
const TX_FORK = txid(0x03);
const TX_UNKNOWN_LWD = txid(0x04);
const TX_UNKNOWN_ZAINO = txid(0x05);
const TX_UNKNOWN_ZEBRA = txid(0x06);
const TX_BACKEND_ERR = txid(0x07);
const TX_INTERNAL_OTHER = txid(0x08);
const TX_UNAVAILABLE = txid(0x09);
const TX_SLOW = txid(0x0a);
const TX_EMPTY = txid(0x0b);

const RAW = Uint8Array.from([0x06, 0x00, 0x00, 0x80, 0x98, 0xb6, 0x84, 0xd8, 0x00, 0x01, 0x02, 0x03]);

const LWD_NOT_FOUND =
  "GetTransaction: getrawtransaction 6a4d05db680f671812820c5ca3e68588e9c9487cc0ce5279f882838a388347cf failed: -5: Transaction not found in mempool or best chain";
const ZAINO_NOT_FOUND =
  'RPC error: LegacyRpcError { code: -5, message: "No such mempool or main chain transaction" }';
const ZEBRA_NOT_FOUND = "transaction not found";
const LWD_BACKEND_ERROR =
  "GetTransaction: getrawtransaction 6a4d05db680f671812820c5ca3e68588e9c9487cc0ce5279f882838a388347cf failed: -28: Loading block index...";
const ZAINO_OTHER_ERROR = 'RPC error: LegacyRpcError { code: -28, message: "Verifying blocks..." }';

const INFO = {
  version: "v0.5.4",
  vendor: "ECC LightWalletD",
  taddrSupport: true,
  chainName: "test",
  saplingActivationHeight: "280000",
  consensusBranchId: "77190ad9",
  blockHeight: "4547207",
  gitCommit: "v0.5.4-0-gc22ca9b",
  branch: "",
  buildDate: "2026-09-01",
  buildUser: "builder",
  estimatedHeight: "4547300",
  zcashdBuild: "v6.2.3",
  zcashdSubversion: "/Zebra:6.2.3/",
  donationAddress: "",
  upgradeName: "",
  upgradeHeight: "4600000",
  lightwalletProtocolVersion: "0.4.0",
};

const SCRIPT: FakeLwdScript = {
  txs: {
    [TX]: { tx: { data: RAW, height: "0" } },
    [TX_MINED]: { tx: { data: RAW, height: "4521112" } },
    [TX_FORK]: { tx: { data: RAW, height: "18446744073709551615" } },
    [TX_UNKNOWN_LWD]: { fail: { code: status.NOT_FOUND, details: LWD_NOT_FOUND } },
    [TX_UNKNOWN_ZAINO]: { fail: { code: status.INTERNAL, details: ZAINO_NOT_FOUND } },
    [TX_UNKNOWN_ZEBRA]: { fail: { code: status.NOT_FOUND, details: ZEBRA_NOT_FOUND } },
    [TX_BACKEND_ERR]: { fail: { code: status.NOT_FOUND, details: LWD_BACKEND_ERROR } },
    [TX_INTERNAL_OTHER]: { fail: { code: status.INTERNAL, details: ZAINO_OTHER_ERROR } },
    [TX_UNAVAILABLE]: { fail: { code: status.UNAVAILABLE, details: "upstream connect error" } },
    [TX_SLOW]: { tx: { data: RAW, height: "4521112" }, delayMs: 300 },
    [TX_EMPTY]: { tx: { data: new Uint8Array(), height: "4521112" } },
  },
  latestBlock: { height: "4547207" },
  lightdInfo: INFO,
};

describe("txidToFilterHash", () => {
  test("txid bytes are reversed for TxFilter.hash", () => {
    expect(txidToFilterHash("00".repeat(31) + "ff")[0]).toBe(0xff);
    expect(txidToFilterHash(TX).toString("hex")).toBe(TX_ON_THE_WIRE);
    expect(() => txidToFilterHash("AB".repeat(32))).toThrow(TypeError);
  });

  test.each([
    ["uppercase hex", "AB".repeat(32)],
    ["63 characters", "ab".repeat(31) + "a"],
    ["66 characters", "ab".repeat(33)],
    ["non-hex characters", "zz".repeat(32)],
    ["a 0x prefix", "0x" + "ab".repeat(31)],
    ["an empty string", ""],
    ["a trailing newline", "ab".repeat(32) + "\n"],
  ])("rejects %s with TypeError", (_name, bad) => {
    expect(() => txidToFilterHash(bad)).toThrow(TypeError);
  });
});

describe("isDefinitiveNotFound", () => {
  test.each([
    ["lightwalletd NOT_FOUND with the -5 text", status.NOT_FOUND, LWD_NOT_FOUND, true],
    ["Zaino INTERNAL with the LegacyRpcError -5 text", status.INTERNAL, ZAINO_NOT_FOUND, true],
    ["Zebra NOT_FOUND with the lowercase text", status.NOT_FOUND, ZEBRA_NOT_FOUND, true],
    ["the lightwalletd text under INTERNAL", status.INTERNAL, LWD_NOT_FOUND, false],
    ["the lightwalletd text under UNKNOWN", status.UNKNOWN, LWD_NOT_FOUND, false],
    ["the lightwalletd text under UNAVAILABLE", status.UNAVAILABLE, LWD_NOT_FOUND, false],
    ["the Zaino text under NOT_FOUND", status.NOT_FOUND, ZAINO_NOT_FOUND, false],
    ["the Zaino text under UNAVAILABLE", status.UNAVAILABLE, ZAINO_NOT_FOUND, false],
    ["the Zebra text under INTERNAL", status.INTERNAL, ZEBRA_NOT_FOUND, false],
    ["NOT_FOUND carrying a backend error", status.NOT_FOUND, LWD_BACKEND_ERROR, false],
    ["NOT_FOUND carrying a -5 about a block", status.NOT_FOUND, "getblock failed: -5: Block not found", false],
    ["NOT_FOUND with empty details", status.NOT_FOUND, "", false],
    ["INTERNAL with another LegacyRpcError code", status.INTERNAL, ZAINO_OTHER_ERROR, false],
    [
      "INTERNAL with LegacyRpcError -5 and another message",
      status.INTERNAL,
      'RPC error: LegacyRpcError { code: -5, message: "Block not found" }',
      false,
    ],
  ])("%s", (_name, code, details, expected) => {
    expect(isDefinitiveNotFound({ code, details })).toBe(expected);
  });
});

describe("createLightwalletdClient url", () => {
  test.each([
    ["a bare host and port", "127.0.0.1:28137"],
    ["a host name with a port", "localhost:28137"],
    ["a misspelled scheme", "htps://127.0.0.1:28137"],
    ["a grpc scheme", "grpc://127.0.0.1:28137"],
    ["an empty string", ""],
  ])("rejects %s with TypeError instead of guessing a transport", (_name, url) => {
    expect(() => createLightwalletdClient({ url })).toThrow(TypeError);
  });
});

describe("against a gRPC server speaking the lightwalletd protos", () => {
  let fake: FakeLwd;
  let c: LightwalletdClient;
  const clients: LightwalletdClient[] = [];

  const connect = (url: string, rpcDeadlineMs?: number): LightwalletdClient => {
    const client = createLightwalletdClient({ url, rpcDeadlineMs });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    fake = await startFakeLwd(SCRIPT);
    c = connect(fake.url);
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    fake.close();
  });

  test("mempool height 0 maps to location mempool", async () =>
    expect(await c.getTransaction(TX)).toEqual({ found: true, raw: RAW, location: "mempool", height: null }));

  test("mined height maps to a number", async () =>
    expect(await c.getTransaction(TX_MINED)).toEqual({
      found: true,
      raw: RAW,
      location: "mined",
      height: 4521112,
    }));

  test("fork sentinel maps to orphaned", async () =>
    expect(await c.getTransaction(TX_FORK)).toEqual({
      found: true,
      raw: RAW,
      location: "orphaned",
      height: null,
    }));

  test("raw is an exact-size Uint8Array, not a view into the gRPC receive buffer", async () => {
    const reply = await c.getTransaction(TX_MINED);
    if (!reply.found) throw new Error("expected a found transaction");
    expect(reply.raw.byteOffset).toBe(0);
    expect(reply.raw.buffer.byteLength).toBe(RAW.length);
  });

  describe("only the three definitive answers are not-found", () => {
    test.each([
      ["lightwalletd NOT_FOUND with the -5 text", TX_UNKNOWN_LWD],
      ["Zaino INTERNAL with the LegacyRpcError -5 text", TX_UNKNOWN_ZAINO],
      ["Zebra NOT_FOUND with the lowercase text", TX_UNKNOWN_ZEBRA],
    ])("%s resolves found:false", async (_name, id) => {
      expect(await c.getTransaction(id)).toEqual({ found: false });
    });

    test.each([
      ["NOT_FOUND with another backend error", TX_BACKEND_ERR],
      ["INTERNAL with another error", TX_INTERNAL_OTHER],
      ["UNAVAILABLE", TX_UNAVAILABLE],
    ])("%s throws ChainUnavailableError", async (_name, id) => {
      await expect(c.getTransaction(id)).rejects.toBeInstanceOf(ChainUnavailableError);
    });
  });

  test("an OK reply with no transaction data is ChainUnavailableError, never found:true", async () => {
    await expect(c.getTransaction(TX_EMPTY)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  test("ChainUnavailableError names the gRPC code and details and keeps the raw error as cause", async () => {
    const err = await c.getTransaction(TX_UNAVAILABLE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    const { message, cause } = err as ChainUnavailableError;
    expect(message).toContain("UNAVAILABLE");
    expect(message).toContain("upstream connect error");
    expect(cause).toMatchObject({ code: status.UNAVAILABLE, details: "upstream connect error" });
  });

  test("deadline exceeded is ChainUnavailableError", async () => {
    const slow = connect(fake.url, 100);
    const err = await slow.getTransaction(TX_SLOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toMatchObject({ code: status.DEADLINE_EXCEEDED });
  });

  test("every call carries a 5 s deadline by default", async () => {
    await c.getTip();
    await c.getLightdInfo();
    await c.getTransaction(TX);
    expect(fake.calls.map((call) => call.rpc)).toEqual(["GetLatestBlock", "GetLightdInfo", "GetTransaction"]);
    for (const { remainingMs } of fake.calls) {
      expect(remainingMs).toBeGreaterThan(4000);
      expect(remainingMs).toBeLessThanOrEqual(5000);
    }
  });

  test("server receives reversed hash", async () => {
    await c.getTransaction(TX);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.hash?.toString("hex")).toBe(TX_ON_THE_WIRE);
  });

  test("an invalid txid rejects with TypeError and sends no request", async () => {
    await expect(c.getTransaction("AB".repeat(32))).rejects.toBeInstanceOf(TypeError);
    await expect(c.getTransaction("ab".repeat(31))).rejects.toBeInstanceOf(TypeError);
    expect(fake.calls).toEqual([]);
  });

  test("getTip and getLightdInfo map fields", async () => {
    expect(await c.getTip()).toBe(4547207);
    expect(await c.getLightdInfo()).toEqual({
      chainName: "test",
      consensusBranchId: "77190ad9",
      blockHeight: 4547207,
      version: "v0.5.4",
    });
  });

  test("getTip and getLightdInfo failures are ChainUnavailableError even for a not-found answer", async () => {
    const broken = await startFakeLwd({
      latestBlock: { fail: { code: status.NOT_FOUND, details: LWD_NOT_FOUND } },
      lightdInfo: { fail: { code: status.UNAVAILABLE, details: "node is syncing" } },
    });
    try {
      const b = connect(broken.url);
      await expect(b.getTip()).rejects.toBeInstanceOf(ChainUnavailableError);
      await expect(b.getLightdInfo()).rejects.toBeInstanceOf(ChainUnavailableError);
    } finally {
      broken.close();
    }
  });

  test("close() releases the channel, so a later call fails without reaching the server", async () => {
    await c.getTip();
    c.close();
    await expect(c.getTip()).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(fake.calls).toHaveLength(1);
  });

  test("an unreachable server is ChainUnavailableError", async () => {
    const gone = await startFakeLwd();
    const { url } = gone;
    gone.close();
    const err = await connect(url).getTip().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toMatchObject({ code: status.UNAVAILABLE });
  });

  test("an https url speaks TLS, so a plaintext server fails as ChainUnavailableError", async () => {
    const tls = connect(fake.url.replace("http://", "https://"), 1500);
    await expect(tls.getTip()).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(fake.calls).toEqual([]);
  });
});
