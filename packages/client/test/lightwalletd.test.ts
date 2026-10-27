import { ChainUnavailableError, ProtocolError } from "@z402/protocol";
import { describe, expect, it } from "vitest";
import { LightwalletdTxStatus, type LightwalletdLike, type RawTx } from "../src/index.js";

const TXID = "ab".repeat(32);

/** The 20 bytes up to and including the expiry height of a transaction with the given version */
function header(version: number, expiry: number): Uint8Array {
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  view.setUint32(0, (0x80000000 | version) >>> 0, true);
  view.setUint32(16, expiry, true);
  return out;
}

const v6Header = (expiry: number): Uint8Array => header(6, expiry);

/** A hand-written lightwalletd whose answers the test sets */
function stub(o: { tip?: number; tx?: RawTx | Error; tipError?: Error } = {}): LightwalletdLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getTip: async () => {
      if (o.tipError !== undefined) throw o.tipError;
      return o.tip ?? 0;
    },
    getTransaction: async (txid) => {
      asked.push(txid);
      const tx = o.tx ?? { found: false };
      if (tx instanceof Error) throw tx;
      return tx;
    },
  };
}

describe("LightwalletdTxStatus.status", () => {
  it("maps a mempool transaction", async () => {
    const lwd = stub({ tx: { found: true, location: "mempool", height: null, raw: v6Header(5000) } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toEqual({
      found: true,
      location: "mempool",
      minedHeight: null,
      expiryHeight: 5000,
    });
    expect(lwd.asked).toEqual([TXID]);
  });

  it("maps a mined transaction with its height", async () => {
    const lwd = stub({ tx: { found: true, location: "mined", height: 4000, raw: v6Header(5000) } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toEqual({
      found: true,
      location: "mined",
      minedHeight: 4000,
      expiryHeight: 5000,
    });
  });

  it("reads the expiry of a v5 transaction too", async () => {
    const lwd = stub({ tx: { found: true, location: "mempool", height: null, raw: header(5, 321) } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toMatchObject({ expiryHeight: 321 });
  });

  it("reports an orphaned transaction without a mined height", async () => {
    const lwd = stub({ tx: { found: true, location: "orphaned", height: null, raw: v6Header(5000) } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toEqual({
      found: true,
      location: "orphaned",
      minedHeight: null,
      expiryHeight: 5000,
    });
  });

  it("sets minedHeight only for a mined transaction", async () => {
    const lwd = stub({ tx: { found: true, location: "orphaned", height: 3999, raw: v6Header(5000) } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toMatchObject({ minedHeight: null });
  });

  it("passes a definitive not-found through", async () => {
    const lwd = stub({ tx: { found: false } });
    await expect(new LightwalletdTxStatus(lwd).status(TXID)).resolves.toEqual({ found: false });
  });

  it("rejects with the same ChainUnavailableError the client threw", async () => {
    const outage = new ChainUnavailableError("lightwalletd is down");
    const source = new LightwalletdTxStatus(stub({ tx: outage }));
    await expect(source.status(TXID)).rejects.toBe(outage);
  });

  it("wraps any other error in ChainUnavailableError with the cause", async () => {
    const boom = new TypeError("txid is not 64 lowercase hex");
    const err: unknown = await new LightwalletdTxStatus(stub({ tx: boom })).status(TXID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toBe(boom);
  });

  it("surfaces a raw transaction that is not v5 or v6 as ChainUnavailableError, never as a found status", async () => {
    const lwd = stub({ tx: { found: true, location: "mempool", height: null, raw: header(4, 5000) } });
    const err: unknown = await new LightwalletdTxStatus(lwd).status(TXID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toBeInstanceOf(ProtocolError);
  });

  it("surfaces a truncated raw transaction the same way", async () => {
    const lwd = stub({ tx: { found: true, location: "mined", height: 4000, raw: new Uint8Array(8) } });
    const err: unknown = await new LightwalletdTxStatus(lwd).status(TXID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toBeInstanceOf(ProtocolError);
  });
});

describe("LightwalletdTxStatus.tip", () => {
  it("delegates to getTip", async () => {
    await expect(new LightwalletdTxStatus(stub({ tip: 4_547_331 })).tip()).resolves.toBe(4_547_331);
  });

  it("rejects with the same ChainUnavailableError the client threw", async () => {
    const outage = new ChainUnavailableError("lightwalletd is down");
    await expect(new LightwalletdTxStatus(stub({ tipError: outage })).tip()).rejects.toBe(outage);
  });

  it("wraps any other error in ChainUnavailableError with the cause", async () => {
    const boom = new Error("socket hang up");
    const err: unknown = await new LightwalletdTxStatus(stub({ tipError: boom })).tip().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainUnavailableError);
    expect((err as ChainUnavailableError).cause).toBe(boom);
  });
});
