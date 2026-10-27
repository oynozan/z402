import { ChainUnavailableError, type TxStatus, type TxStatusSource } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { describe, expect, it } from "vitest";
import { waitForConfirmation } from "../src/wait.js";
import { flush, ManualClock } from "./manual-clock.js";
import { PAY_TO } from "./fixtures.js";

const POLL = 2_000;
const TIMEOUT = 600_000;
const TXID = "ab".repeat(32);

/** Starts a wait and exposes its result once it settles */
function track(p: Promise<string>): { readonly value: string | undefined } {
  const box: { value: string | undefined } = { value: undefined };
  void p.then((v) => {
    box.value = v;
  });
  return box;
}

/** A status source whose answers the test sets directly */
function scripted(): {
  source: TxStatusSource;
  answer: TxStatus | "unavailable";
  tip: number;
  calls: number;
} {
  const s = {
    answer: { found: false } as TxStatus | "unavailable",
    tip: 1000,
    calls: 0,
    source: undefined as unknown as TxStatusSource,
  };
  s.source = {
    tip: async () => s.tip,
    status: async () => {
      s.calls += 1;
      if (s.answer === "unavailable") throw new ChainUnavailableError("scripted outage");
      return s.answer;
    },
  };
  return s;
}

function deposit(chain: FakeChain): string {
  return chain.broadcast({ outputs: [{ to: PAY_TO, valueZat: 100_000n, memo: null }] });
}

describe("waitForConfirmation on FakeChain", () => {
  it("resolves mined once the tx is in a block", async () => {
    const chain = new FakeChain();
    const clock = new ManualClock();
    const txid = deposit(chain);
    const r = track(waitForConfirmation(chain.statusSource(), txid, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));

    await clock.advance(POLL * 3);
    expect(r.value).toBeUndefined();

    chain.mine();
    await clock.advance(POLL);
    expect(r.value).toBe("mined");
    expect(clock.pendingTimers).toBe(0);
  });

  it("resolves mined on the first poll when the tx is already mined", async () => {
    const chain = new FakeChain();
    const clock = new ManualClock();
    const txid = deposit(chain);
    chain.mine();
    const r = track(waitForConfirmation(chain.statusSource(), txid, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    await flush();
    expect(r.value).toBe("mined");
  });

  it("resolves dead when a held tx outlives its expiry", async () => {
    const chain = new FakeChain({ expiryDelta: 3 });
    const clock = new ManualClock();
    const txid = deposit(chain);
    chain.hold(txid);
    const r = track(waitForConfirmation(chain.statusSource(), txid, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));

    chain.mine(3);
    await clock.advance(POLL);
    expect(r.value).toBeUndefined();

    chain.mine();
    await clock.advance(POLL);
    expect(r.value).toBe("dead");
  });

  it("resolves dead when an orphaned tx is past its expiry, and keeps waiting before that", async () => {
    const chain = new FakeChain({ expiryDelta: 3 });
    const clock = new ManualClock();
    const txid = deposit(chain);
    chain.mine();
    chain.reorg(1);
    const r = track(waitForConfirmation(chain.statusSource(), txid, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));

    chain.mine(3);
    await clock.advance(POLL);
    expect(r.value).toBeUndefined();

    chain.mine();
    await clock.advance(POLL);
    expect(r.value).toBe("dead");
  });

  it("retries ChainUnavailableError instead of throwing", async () => {
    const chain = new FakeChain();
    const clock = new ManualClock();
    const txid = deposit(chain);
    chain.setUnavailable(true);
    const p = waitForConfirmation(chain.statusSource(), txid, { timeoutMs: TIMEOUT, pollMs: POLL, clock });
    const r = track(p);

    chain.mine();
    await clock.advance(POLL * 5);
    expect(r.value).toBeUndefined();

    chain.setUnavailable(false);
    await clock.advance(POLL);
    await expect(p).resolves.toBe("mined");
  });

  it("resolves timeout at timeoutMs, polling one last time at the deadline", async () => {
    const chain = new FakeChain();
    const clock = new ManualClock();
    const txid = deposit(chain);
    const r = track(waitForConfirmation(chain.statusSource(), txid, { timeoutMs: 10_000, pollMs: 3_000, clock }));

    await clock.advance(9_999);
    expect(r.value).toBeUndefined();

    await clock.advance(1);
    expect(r.value).toBe("timeout");
    expect(clock.pendingTimers).toBe(0);
  });

  it("rethrows an error that is not ChainUnavailableError", async () => {
    const clock = new ManualClock();
    const source: TxStatusSource = {
      tip: async () => 1000,
      status: async () => {
        throw new TypeError("bug");
      },
    };
    await expect(waitForConfirmation(source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("waitForConfirmation not-found streak (protocol.md §5.3)", () => {
  it("a single not-found, or 60 s of them within one block, is still pending", async () => {
    const s = scripted();
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    await flush();
    expect(s.calls).toBe(1);
    expect(r.value).toBeUndefined();

    await clock.advance(60_000);
    expect(r.value).toBeUndefined();
    s.answer = { found: true, location: "mined", minedHeight: 1001, expiryHeight: 0 };
    await clock.advance(POLL);
    expect(r.value).toBe("mined");
  });

  it("needs both 120 s and 2 new blocks since the first not-found", async () => {
    const s = scripted();
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));

    await clock.advance(60_000);
    s.tip = 1001;
    await clock.advance(60_000);
    expect(clock.now()).toBe(120_000);
    expect(r.value).toBeUndefined();

    s.tip = 1002;
    await clock.advance(POLL);
    expect(r.value).toBe("dead");
  });

  it("2 new blocks within 60 s are not enough until 120 s have passed", async () => {
    const s = scripted();
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    await flush();

    s.tip = 1002;
    await clock.advance(118_000);
    expect(r.value).toBeUndefined();

    await clock.advance(POLL);
    expect(r.value).toBe("dead");
  });

  it("one found answer mid-streak resets it", async () => {
    const s = scripted();
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    await flush();

    s.tip = 1005;
    await clock.advance(60_000);
    s.answer = { found: true, location: "mempool", minedHeight: null, expiryHeight: 0 };
    await clock.advance(POLL);
    s.answer = { found: false };
    await clock.advance(POLL);
    expect(clock.now()).toBe(64_000);

    await clock.advance(58_000);
    expect(r.value).toBeUndefined();

    s.tip = 1007;
    await clock.advance(60_000);
    expect(r.value).toBeUndefined();
    await clock.advance(POLL);
    expect(clock.now()).toBe(184_000);
    expect(r.value).toBe("dead");
  });

  it("a ChainUnavailableError mid-streak does not reset it", async () => {
    const s = scripted();
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    await flush();

    s.answer = "unavailable";
    s.tip = 1002;
    await clock.advance(118_000);
    expect(r.value).toBeUndefined();

    s.answer = { found: false };
    await clock.advance(POLL);
    expect(r.value).toBe("dead");
  });

  it("a ChainUnavailableError does not count toward the streak", async () => {
    const s = scripted();
    s.answer = "unavailable";
    const clock = new ManualClock();
    const r = track(waitForConfirmation(s.source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));

    s.tip = 1002;
    await clock.advance(120_000);
    s.answer = { found: false };
    await clock.advance(POLL);
    expect(r.value).toBeUndefined();

    s.tip = 1004;
    await clock.advance(118_000);
    expect(r.value).toBeUndefined();

    await clock.advance(POLL);
    expect(clock.now()).toBe(242_000);
    expect(r.value).toBe("dead");
  });

  it("a not-found whose tip read fails does not start the streak", async () => {
    const clock = new ManualClock();
    let tip = 1000;
    let tipDown = true;
    const source: TxStatusSource = {
      tip: async () => {
        if (tipDown) throw new ChainUnavailableError("tip down");
        return tip;
      },
      status: async () => ({ found: false }),
    };
    const r = track(waitForConfirmation(source, TXID, { timeoutMs: TIMEOUT, pollMs: POLL, clock }));
    tip = 1010;
    await clock.advance(200_000);
    expect(r.value).toBeUndefined();

    tipDown = false;
    await clock.advance(POLL);
    tip = 1012;
    await clock.advance(POLL);
    expect(r.value).toBeUndefined();

    await clock.advance(116_000);
    expect(r.value).toBeUndefined();
    await clock.advance(POLL);
    expect(clock.now()).toBe(322_000);
    expect(r.value).toBe("dead");
  });
});
