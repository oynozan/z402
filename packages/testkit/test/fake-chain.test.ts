import { ChainUnavailableError, type FoundInspection } from "@z402/protocol";
import { describe, expect, it } from "vitest";
import { FakeChain } from "../src/index.js";

const PAY_TO = "uregtest1" + "q".repeat(60);
const OTHER = "uregtest1" + "p".repeat(60);
const MEMO = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8:1";

function out(to = PAY_TO, valueZat = 100_000n, memo: string | null = MEMO) {
  return { to, valueZat, memo };
}

async function found(chain: FakeChain, txid: string, payTo = PAY_TO): Promise<FoundInspection> {
  const r = await chain.viewFor(payTo).inspect(txid);
  if (!r.found) throw new Error("expected found:true");
  return r;
}

describe("FakeChain.broadcast", () => {
  it("returns a lowercase 64-hex txid, distinct and deterministic", () => {
    const a = new FakeChain();
    const t1 = a.broadcast({ outputs: [out()] });
    const t2 = a.broadcast({ outputs: [out()] });
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).not.toBe(t1);
    expect(new FakeChain().broadcast({ outputs: [out()] })).toBe(t1);
  });

  it("starts at height 1000 unless told otherwise", () => {
    expect(new FakeChain().height).toBe(1000);
    expect(new FakeChain({ startHeight: 5 }).height).toBe(5);
  });
});

describe("FakeChain inspect", () => {
  it("shows a broadcast tx in the mempool with only the viewed payTo's outputs", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({
      outputs: [out(PAY_TO, 100_000n, MEMO), out(OTHER, 7n, "change"), out(PAY_TO, 5n, null)],
    });
    const r = await found(chain, txid);
    expect(r).toEqual({
      found: true,
      txid,
      location: "mempool",
      minedHeight: null,
      expiryHeight: 1000 + 1 + 120,
      hasTransparent: false,
      outputs: [
        { pool: "ironwood", valueZat: 100_000n, memo: MEMO },
        { pool: "ironwood", valueZat: 5n, memo: null },
      ],
    });
    const other = await found(chain, txid, OTHER);
    expect(other.outputs).toEqual([{ pool: "ironwood", valueZat: 7n, memo: "change" }]);
    const nobody = await found(chain, txid, "uregtest1" + "z".repeat(60));
    expect(nobody.outputs).toEqual([]);
  });

  it("passes hasTransparent through", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], hasTransparent: true });
    expect((await found(chain, txid)).hasTransparent).toBe(true);
  });

  it("reports an unknown txid as found:false", async () => {
    const chain = new FakeChain();
    expect(await chain.viewFor(PAY_TO).inspect("ab".repeat(32))).toEqual({ found: false });
    expect(await chain.statusSource().status("ab".repeat(32))).toEqual({ found: false });
  });

  it("is not affected by later mutation of the broadcast input or of a returned inspection", async () => {
    const chain = new FakeChain();
    const outputs = [out()];
    const txid = chain.broadcast({ outputs });
    outputs[0]!.valueZat = 1n;
    outputs.push(out());
    const first = await found(chain, txid);
    expect(first.outputs).toEqual([{ pool: "ironwood", valueZat: 100_000n, memo: MEMO }]);
    first.outputs.length = 0;
    expect((await found(chain, txid)).outputs).toHaveLength(1);
  });

  it("exposes the tip through both the view and the status source", async () => {
    const chain = new FakeChain({ startHeight: 50 });
    expect(await chain.viewFor(PAY_TO).tip()).toBe(50);
    expect(await chain.statusSource().tip()).toBe(50);
    chain.mine(2);
    expect(chain.height).toBe(52);
    expect(await chain.viewFor(PAY_TO).tip()).toBe(52);
    expect(await chain.statusSource().tip()).toBe(52);
  });
});

describe("FakeChain.mine", () => {
  it("mines a mempool tx into the next block", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    const before = chain.height;
    chain.mine();
    expect(chain.height).toBe(before + 1);
    const r = await found(chain, txid);
    expect(r.location).toBe("mined");
    expect(r.minedHeight).toBe(before + 1);
    expect(await chain.statusSource().status(txid)).toEqual({
      found: true,
      location: "mined",
      minedHeight: before + 1,
      expiryHeight: 1000 + 1 + 120,
    });
  });

  it("includes a tx only in the first block of a multi-block mine", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    chain.mine(3);
    expect(chain.height).toBe(1003);
    expect((await found(chain, txid)).minedHeight).toBe(1001);
  });

  it("puts txs broadcast between blocks into the following block", async () => {
    const chain = new FakeChain();
    const a = chain.broadcast({ outputs: [out()] });
    chain.mine();
    const b = chain.broadcast({ outputs: [out()] });
    chain.mine();
    expect((await found(chain, a)).minedHeight).toBe(1001);
    expect((await found(chain, b)).minedHeight).toBe(1002);
  });

  it("keeps a held tx out of blocks", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    chain.hold(txid);
    chain.mine(5);
    const r = await found(chain, txid);
    expect(r.location).toBe("mempool");
    expect(r.minedHeight).toBeNull();
  });
});

describe("FakeChain expiry", () => {
  it("sets expiryHeight to height + 1 + delta, honouring the per-tx override", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const a = chain.broadcast({ outputs: [out()] });
    const b = chain.broadcast({ outputs: [out()], expiryDelta: 3 });
    expect((await found(chain, a)).expiryHeight).toBe(1041);
    expect((await found(chain, b)).expiryHeight).toBe(1004);
  });

  it("evicts a held tx once the tip reaches its expiryHeight", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], expiryDelta: 3 });
    chain.hold(txid);
    chain.mine(3);
    expect(chain.height).toBe(1003);
    expect((await found(chain, txid)).location).toBe("mempool");
    chain.mine();
    expect(chain.height).toBe(1004);
    expect(await chain.viewFor(PAY_TO).inspect(txid)).toEqual({ found: false });
    expect(await chain.statusSource().status(txid)).toEqual({ found: false });
  });

  it("never evicts a tx with expiryDelta 0 (expiryHeight 0)", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], expiryDelta: 0 });
    expect((await found(chain, txid)).expiryHeight).toBe(0);
    chain.hold(txid);
    chain.mine(500);
    expect((await found(chain, txid)).location).toBe("mempool");
  });

  it("mines a tx on the block at its expiryHeight instead of evicting it", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], expiryDelta: 1 });
    chain.mine();
    chain.orphan(txid);
    chain.rebroadcast(txid);
    chain.mine();
    const r = await found(chain, txid);
    expect(r.expiryHeight).toBe(1002);
    expect(r.location).toBe("mined");
    expect(r.minedHeight).toBe(1002);
  });

  it("evicts a rebroadcast tx that is already past its expiry instead of mining it", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], expiryDelta: 1 });
    expect((await found(chain, txid)).expiryHeight).toBe(1002);
    chain.mine(2);
    chain.reorg(2);
    chain.mine(2);
    chain.rebroadcast(txid);
    chain.mine();
    expect(await chain.viewFor(PAY_TO).inspect(txid)).toEqual({ found: false });
  });

  it("does not expire mined txs", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()], expiryDelta: 2 });
    chain.mine(50);
    expect((await found(chain, txid)).location).toBe("mined");
  });
});

describe("FakeChain.drop", () => {
  it("evicts a mempool tx immediately and leaves mined txs alone", async () => {
    const chain = new FakeChain();
    const mined = chain.broadcast({ outputs: [out()] });
    chain.mine();
    const pending = chain.broadcast({ outputs: [out()] });
    chain.drop(pending);
    expect(await chain.viewFor(PAY_TO).inspect(pending)).toEqual({ found: false });
    expect(await chain.statusSource().status(pending)).toEqual({ found: false });
    chain.mine();
    expect(await chain.viewFor(PAY_TO).inspect(pending)).toEqual({ found: false });
    const r = await found(chain, mined);
    expect(r.location).toBe("mined");
    expect(r.minedHeight).toBe(1001);
  });

  it("refuses to drop a mined tx", () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    chain.mine();
    expect(() => chain.drop(txid)).toThrow(/mined/);
  });

  it("is a no-op for an unknown txid", () => {
    expect(() => new FakeChain().drop("ab".repeat(32))).not.toThrow();
  });
});

describe("FakeChain reorg", () => {
  it("orphans the txs of the dropped block; rebroadcast and mine bring them back", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    chain.mine();
    chain.reorg(1);
    expect(chain.height).toBe(1000);
    const r = await found(chain, txid);
    expect(r.location).toBe("orphaned");
    expect(r.minedHeight).toBeNull();
    expect(await chain.statusSource().status(txid)).toEqual({
      found: true,
      location: "orphaned",
      minedHeight: null,
      expiryHeight: 1121,
    });

    chain.mine();
    expect((await found(chain, txid)).location).toBe("orphaned");

    chain.rebroadcast(txid);
    expect((await found(chain, txid)).location).toBe("mempool");

    const heightBefore = chain.height;
    chain.mine();
    const again = await found(chain, txid);
    expect(again.location).toBe("mined");
    expect(again.minedHeight).toBe(heightBefore + 1);
  });

  it("orphans only txs in the dropped blocks", async () => {
    const chain = new FakeChain();
    const a = chain.broadcast({ outputs: [out()] });
    chain.mine();
    const b = chain.broadcast({ outputs: [out()] });
    chain.mine();
    const c = chain.broadcast({ outputs: [out()] });
    chain.mine();
    chain.reorg(2);
    expect(chain.height).toBe(1001);
    expect((await found(chain, a)).location).toBe("mined");
    expect((await found(chain, a)).minedHeight).toBe(1001);
    expect((await found(chain, b)).location).toBe("orphaned");
    expect((await found(chain, c)).location).toBe("orphaned");
  });

  it("does not touch mempool txs", async () => {
    const chain = new FakeChain();
    chain.mine(2);
    const txid = chain.broadcast({ outputs: [out()] });
    chain.reorg(1);
    expect((await found(chain, txid)).location).toBe("mempool");
  });

  it("rejects a depth that is negative, fractional or deeper than the chain", () => {
    const chain = new FakeChain({ startHeight: 3 });
    expect(() => chain.reorg(-1)).toThrow(RangeError);
    expect(() => chain.reorg(1.5)).toThrow(RangeError);
    expect(() => chain.reorg(4)).toThrow(RangeError);
  });
});

describe("FakeChain.orphan", () => {
  it("marks one mined tx orphaned without moving the tip", async () => {
    const chain = new FakeChain();
    const a = chain.broadcast({ outputs: [out()] });
    const b = chain.broadcast({ outputs: [out()] });
    chain.mine();
    chain.orphan(a);
    expect(chain.height).toBe(1001);
    const ra = await found(chain, a);
    expect(ra.location).toBe("orphaned");
    expect(ra.minedHeight).toBeNull();
    expect((await found(chain, b)).location).toBe("mined");
  });

  it("only applies to mined txs", () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    expect(() => chain.orphan(txid)).toThrow(/mined/);
    expect(() => chain.orphan("ab".repeat(32))).toThrow(/unknown/);
  });
});

describe("FakeChain lifecycle guards", () => {
  it("rebroadcast only applies to orphaned txs", () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    expect(() => chain.rebroadcast(txid)).toThrow(/orphaned/);
    expect(() => chain.rebroadcast("ab".repeat(32))).toThrow(/unknown/);
  });

  it("hold only applies to mempool txs", () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    chain.mine();
    expect(() => chain.hold(txid)).toThrow(/mempool/);
    expect(() => chain.hold("ab".repeat(32))).toThrow(/unknown/);
  });

  it("mine rejects a negative or fractional block count", () => {
    const chain = new FakeChain();
    expect(() => chain.mine(-1)).toThrow(RangeError);
    expect(() => chain.mine(0.5)).toThrow(RangeError);
    chain.mine(0);
    expect(chain.height).toBe(1000);
  });
});

describe("FakeChain.setUnavailable", () => {
  it("makes tip, inspect and status reject with ChainUnavailableError until switched off", async () => {
    const chain = new FakeChain();
    const txid = chain.broadcast({ outputs: [out()] });
    const view = chain.viewFor(PAY_TO);
    const source = chain.statusSource();
    chain.setUnavailable(true);
    await expect(view.tip()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(view.inspect(txid)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(source.tip()).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(source.status(txid)).rejects.toBeInstanceOf(ChainUnavailableError);
    chain.setUnavailable(false);
    expect(await view.tip()).toBe(1000);
    expect((await view.inspect(txid)).found).toBe(true);
    expect((await source.status(txid)).found).toBe(true);
  });

  it("does not stop writes", async () => {
    const chain = new FakeChain();
    chain.setUnavailable(true);
    const txid = chain.broadcast({ outputs: [out()] });
    chain.mine();
    chain.setUnavailable(false);
    expect((await found(chain, txid)).location).toBe("mined");
  });
});
