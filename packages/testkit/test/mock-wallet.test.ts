import type { ZcashWallet } from "@z402-net/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeChain, MockWallet } from "../src/index.js";

const PAY_TO = "uregtest1" + "q".repeat(60);
const MEMO = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8:1";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockWallet", () => {
  it("is a ZcashWallet", () => {
    const wallet: ZcashWallet = new MockWallet(new FakeChain());
    expect(typeof wallet.sendDeposit).toBe("function");
  });

  it("broadcasts one output to the requested address and records the request", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    const req = { to: PAY_TO, amountZat: 100_000n, memo: MEMO };
    const { txid } = await wallet.sendDeposit(req);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    expect(wallet.sent).toEqual([req]);

    const r = await chain.viewFor(PAY_TO).inspect(txid);
    expect(r).toMatchObject({
      found: true,
      location: "mempool",
      hasTransparent: false,
      outputs: [{ pool: "ironwood", valueZat: 100_000n, memo: MEMO }],
    });
  });

  it("records every request in order", async () => {
    const wallet = new MockWallet(new FakeChain());
    const a = { to: PAY_TO, amountZat: 1n, memo: "a" };
    const b = { to: PAY_TO, amountZat: 2n, memo: "b" };
    const ra = await wallet.sendDeposit(a);
    const rb = await wallet.sendDeposit(b);
    expect(ra.txid).not.toBe(rb.txid);
    expect(wallet.sent).toEqual([a, b]);
  });

  it("rejects exactly once with the failNext error, recording and broadcasting nothing", async () => {
    const chain = new FakeChain();
    const boom = new Error("wallet is locked");
    const wallet = new MockWallet(chain, { failNext: boom });
    const req = { to: PAY_TO, amountZat: 5n, memo: MEMO };

    await expect(wallet.sendDeposit(req)).rejects.toBe(boom);
    expect(wallet.sent).toEqual([]);

    const { txid } = await wallet.sendDeposit(req);
    expect(wallet.sent).toEqual([req]);
    expect(txid).toBe(new FakeChain().broadcast({ outputs: [{ to: PAY_TO, valueZat: 5n, memo: MEMO }] }));
  });

  it("failNextWith fails exactly the next send, after a successful one", async () => {
    const wallet = new MockWallet(new FakeChain());
    const boom = new Error("wallet is locked");
    const req = { to: PAY_TO, amountZat: 5n, memo: MEMO };

    await wallet.sendDeposit(req);
    wallet.failNextWith(boom);
    await expect(wallet.sendDeposit(req)).rejects.toBe(boom);
    expect(wallet.sent).toHaveLength(1);

    await wallet.sendDeposit(req);
    expect(wallet.sent).toHaveLength(2);
  });

  it("failNextWith can be armed again after it has fired", async () => {
    const wallet = new MockWallet(new FakeChain());
    const first = new Error("first");
    const second = new Error("second");
    const req = { to: PAY_TO, amountZat: 5n, memo: MEMO };

    wallet.failNextWith(first);
    await expect(wallet.sendDeposit(req)).rejects.toBe(first);
    wallet.failNextWith(second);
    await expect(wallet.sendDeposit(req)).rejects.toBe(second);
    expect(wallet.sent).toEqual([]);
  });

  it("delays the deposit by latencyMs", async () => {
    vi.useFakeTimers();
    const chain = new FakeChain();
    const wallet = new MockWallet(chain, { latencyMs: 250 });
    const req = { to: PAY_TO, amountZat: 5n, memo: MEMO };

    let settled = false;
    const pending = wallet.sendDeposit(req).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    expect(wallet.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const { txid } = await pending;
    expect(settled).toBe(true);
    expect(wallet.sent).toEqual([req]);
    expect((await chain.viewFor(PAY_TO).inspect(txid)).found).toBe(true);
  });
});
