import { ChainUnavailableError, type ChainView } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { commit, FacilitatorState } from "../../src/core/state.js";
import { ChainWatcher } from "../../src/core/watcher.js";
import { depositEvent } from "./events.js";
import { OTHER_SESSION_KEY, SESSION_KEY } from "./records.js";

const PAY_TO = "uregtest1merchant";
const TICK = 5000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A FakeChain behind a watcher that commits into a real state, with every committed batch recorded */
function rig(wrap: (view: ChainView) => ChainView = (view) => view, over: { sweepMs?: number } = {}) {
  const fake = new FakeChain({ expiryDelta: 40 });
  const view = fake.viewFor(PAY_TO);
  const ledger = new Ledger();
  const state = new FacilitatorState();
  const batches: LedgerEvent[][] = [];
  const control = { commitError: undefined as Error | undefined };
  const log = vi.fn<(msg: string, err?: unknown) => void>();
  const watcher = new ChainWatcher({
    chain: wrap(view),
    state,
    log,
    ...over,
    commit: (events) => {
      if (control.commitError !== undefined) throw control.commitError;
      batches.push(events);
      commit(ledger, state, events);
    },
  });

  /** Broadcasts a deposit to the merchant and credits it to a session, as verify would */
  async function credit(sessionKey = SESSION_KEY): Promise<string> {
    const txid = fake.broadcast({ outputs: [{ to: PAY_TO, valueZat: 100000n, memo: `${sessionKey}:1` }] });
    const seen = await view.inspect(txid);
    if (!seen.found) throw new Error("the deposit should be in the mempool");
    const event = depositEvent({ txid, sessionKey, expiryHeight: seen.expiryHeight, firstSeenTip: fake.height });
    commit(ledger, state, [event]);
    return txid;
  }

  return { fake, view, state, batches, control, log, watcher, credit };
}

/** A chain view whose inspects can be made to see nothing or to fail, per txid */
function blinkable() {
  const hidden = new Set<string>();
  const broken = new Set<string>();
  const wrap = (view: ChainView): ChainView => ({
    tip: () => view.tip(),
    inspect: async (txid) => {
      if (broken.has(txid)) throw new ChainUnavailableError("lightwalletd is unreachable");
      return hidden.has(txid) ? { found: false } : view.inspect(txid);
    },
  });
  return { hidden, broken, wrap };
}

describe("a deposit moving through its lifecycle", () => {
  test("a pending deposit seen mined after a tip change commits confirmed with 1 confirmation", async () => {
    const { fake, state, batches, watcher, credit } = rig();
    const txid = await credit();
    await watcher.pollNow();
    expect(batches).toEqual([]);

    watcher.start();
    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    expect(batches).toEqual([
      [{ t: "status", txid, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null }],
    ]);
    expect(state.deposit(txid)).toMatchObject({ status: "confirmed", minedHeight: 1001, confirmations: 1 });
  });

  test("each new block adds a confirmation and the tenth makes it final", async () => {
    const { fake, batches, watcher, credit } = rig();
    const txid = await credit();
    watcher.start();

    for (let block = 1; block <= 10; block++) {
      fake.mine();
      await vi.advanceTimersByTimeAsync(TICK);
    }

    const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((confirmations) => [
      {
        t: "status",
        txid,
        status: confirmations === 10 ? "final" : "confirmed",
        minedHeight: 1001,
        confirmations,
        deadAtTip: null,
      },
    ]);
    expect(batches).toEqual(expected);
  });

  test("nine blocks later it is final, and a final deposit is never inspected again", async () => {
    const { fake, view, batches, watcher, credit } = rig();
    const mined = await credit();
    const waiting = await credit(OTHER_SESSION_KEY);
    fake.hold(waiting);
    watcher.start();
    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    fake.mine(9);
    await vi.advanceTimersByTimeAsync(TICK);

    expect(batches.at(-1)).toEqual([
      { t: "status", txid: mined, status: "final", minedHeight: 1001, confirmations: 10, deadAtTip: null },
    ]);

    const inspect = vi.spyOn(view, "inspect");
    fake.mine(3);
    await vi.advanceTimersByTimeAsync(TICK);

    expect(inspect.mock.calls).toEqual([[waiting]]);
  });

  test("a reorged deposit goes orphaned, and pending again once rebroadcast", async () => {
    const { fake, batches, watcher, credit } = rig();
    const txid = await credit();
    watcher.start();
    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    fake.reorg(1);
    await vi.advanceTimersByTimeAsync(TICK);
    fake.rebroadcast(txid);
    await watcher.pollNow();
    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    expect(batches).toEqual([
      [{ t: "status", txid, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null }],
      [{ t: "status", txid, status: "orphaned", minedHeight: null, confirmations: 0, deadAtTip: null }],
      [{ t: "status", txid, status: "pending", minedHeight: null, confirmations: 0, deadAtTip: null }],
      [{ t: "status", txid, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null }],
    ]);
  });

  test("a deposit mined again in a later block commits its new height", async () => {
    const { fake, batches, watcher, credit } = rig();
    const txid = await credit();
    fake.mine();
    await watcher.pollNow();

    fake.reorg(1);
    fake.rebroadcast(txid);
    fake.hold(txid);
    fake.mine();
    fake.unhold(txid);
    fake.mine();
    await watcher.pollNow();

    expect(batches.at(-1)).toEqual([
      { t: "status", txid, status: "confirmed", minedHeight: 1002, confirmations: 1, deadAtTip: null },
    ]);
  });

  test("a pass commits everything it changed in one call, in credited order", async () => {
    const { fake, batches, watcher, credit } = rig();
    const first = await credit();
    const second = await credit(OTHER_SESSION_KEY);
    fake.mine();

    await watcher.pollNow();

    expect(batches).toEqual([
      [
        { t: "status", txid: first, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null },
        { t: "status", txid: second, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null },
      ],
    ]);
  });

  test("a pass that changes nothing commits nothing", async () => {
    const { watcher, batches, credit } = rig();
    await credit();

    await watcher.pollNow();
    await watcher.pollNow();

    expect(batches).toEqual([]);
  });
});

describe("a deposit that expires or disappears", () => {
  test("a mempool deposit whose tip reaches expiryHeight commits dead", async () => {
    const { fake, batches, watcher, credit } = rig();
    const txid = await credit();
    fake.hold(txid);
    fake.mine(40);
    await watcher.pollNow();
    expect(batches).toEqual([]);

    fake.mine();
    await watcher.pollNow();

    expect(batches).toEqual([
      [{ t: "status", txid, status: "dead", minedHeight: null, confirmations: 0, deadAtTip: 1041 }],
    ]);
  });

  test("a dead deposit is re-inspected for 20 blocks and not after", async () => {
    const { fake, view, watcher, credit } = rig();
    const txid = await credit();
    fake.hold(txid);
    fake.mine(41);
    await watcher.pollNow();
    const inspect = vi.spyOn(view, "inspect");

    fake.mine(20);
    await watcher.pollNow();
    expect(inspect.mock.calls).toEqual([[txid]]);

    fake.mine();
    await watcher.pollNow();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("not found for 120 s and 2 blocks commits dead, counted by the watcher between passes", async () => {
    const { fake, batches, watcher, credit } = rig();
    const txid = await credit();
    fake.drop(txid);
    await watcher.pollNow();
    fake.mine(2);

    vi.advanceTimersByTime(119_999);
    await watcher.pollNow();
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(1);
    await watcher.pollNow();

    expect(batches).toEqual([
      [{ t: "status", txid, status: "dead", minedHeight: null, confirmations: 0, deadAtTip: 1002 }],
    ]);
  });

  test("a found answer resets the streak, so a later absence counts from zero", async () => {
    const eyes = blinkable();
    const { fake, batches, watcher, credit } = rig(eyes.wrap);
    const txid = await credit();
    fake.hold(txid);
    eyes.hidden.add(txid);
    await watcher.pollNow();
    fake.mine(2);

    vi.advanceTimersByTime(100_000);
    eyes.hidden.delete(txid);
    await watcher.pollNow();
    vi.advanceTimersByTime(30_000);
    eyes.hidden.add(txid);
    await watcher.pollNow();
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(119_999);
    fake.mine(2);
    await watcher.pollNow();
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(1);
    await watcher.pollNow();

    expect(batches).toEqual([
      [{ t: "status", txid, status: "dead", minedHeight: null, confirmations: 0, deadAtTip: 1004 }],
    ]);
  });
});

describe("a not-found streak across failed inspects", () => {
  test("failed inspects neither count toward nor reset the streak, so a later not-found still kills", async () => {
    const eyes = blinkable();
    const { fake, batches, watcher, credit } = rig(eyes.wrap);
    const txid = await credit();
    fake.hold(txid);
    eyes.hidden.add(txid);
    await watcher.pollNow();

    eyes.broken.add(txid);
    for (let pass = 0; pass < 3; pass++) {
      vi.advanceTimersByTime(40_000);
      fake.mine();
      await watcher.pollNow();
    }
    expect(batches).toEqual([]);

    eyes.broken.delete(txid);
    await watcher.pollNow();

    expect(batches).toEqual([
      [{ t: "status", txid, status: "dead", minedHeight: null, confirmations: 0, deadAtTip: 1003 }],
    ]);
  });
});

describe("when the chain cannot answer", () => {
  test("an inspect that fails neither counts as not-found nor changes the deposit", async () => {
    const eyes = blinkable();
    const { fake, state, batches, log, watcher, credit } = rig(eyes.wrap);
    const txid = await credit();
    fake.hold(txid);
    eyes.broken.add(txid);

    await watcher.pollNow();
    vi.advanceTimersByTime(60_000);
    await watcher.pollNow();
    fake.mine(2);
    vi.advanceTimersByTime(61_000);
    await watcher.pollNow();

    expect(batches).toEqual([]);
    expect(state.deposit(txid)?.status).toBe("pending");
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([, error]) => error)).toEqual(Array(3).fill(expect.any(ChainUnavailableError)));
  });

  test("a deposit whose inspect fails is skipped and the others are still updated", async () => {
    const eyes = blinkable();
    const { fake, batches, log, watcher, credit } = rig(eyes.wrap);
    const unreadable = await credit();
    const readable = await credit(OTHER_SESSION_KEY);
    eyes.broken.add(unreadable);
    fake.mine();

    await watcher.pollNow();

    expect(batches).toEqual([
      [{ t: "status", txid: readable, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null }],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("tip() throwing ChainUnavailableError means no throw, no commit and one log line", async () => {
    const { fake, batches, log, watcher, credit } = rig();
    await credit();
    fake.setUnavailable(true);
    watcher.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(batches).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBeInstanceOf(ChainUnavailableError);
  });

  test("the watcher keeps ticking and catches up once the chain is back", async () => {
    const { fake, state, log, watcher, credit } = rig();
    const txid = await credit();
    fake.setUnavailable(true);
    watcher.start();
    await vi.advanceTimersByTimeAsync(TICK * 2);

    fake.setUnavailable(false);
    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    expect(state.deposit(txid)?.status).toBe("confirmed");
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("pollNow does not reject when the tip cannot be read", async () => {
    const { fake, log, watcher } = rig();
    fake.setUnavailable(true);

    await expect(watcher.pollNow()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a logger that throws cannot stop the passes after it", async () => {
    const { fake, state, log, watcher, credit } = rig();
    const txid = await credit();
    log.mockImplementation(() => {
      throw new Error("the logger broke");
    });
    fake.setUnavailable(true);
    await expect(watcher.pollNow()).resolves.toBeUndefined();

    fake.setUnavailable(false);
    fake.mine();
    await watcher.pollNow();

    expect(state.deposit(txid)?.status).toBe("confirmed");
  });

  test("a logger that throws on a failed inspect does not end the pass for the other deposits", async () => {
    const eyes = blinkable();
    const { fake, state, log, watcher, credit } = rig(eyes.wrap);
    const unreadable = await credit();
    const readable = await credit(OTHER_SESSION_KEY);
    eyes.broken.add(unreadable);
    log.mockImplementation(() => {
      throw new Error("the logger broke");
    });
    fake.mine();

    await expect(watcher.pollNow()).resolves.toBeUndefined();

    expect(state.deposit(readable)?.status).toBe("confirmed");
  });

  test("a commit that throws is logged as a ledger failure, and the next pass commits the change", async () => {
    const { fake, state, batches, control, log, watcher, credit } = rig();
    const txid = await credit();
    fake.mine();
    control.commitError = new Error("disk full");

    await expect(watcher.pollNow()).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("ledger");
    expect(log.mock.calls[0]?.[1]).toBe(control.commitError);
    expect(state.deposit(txid)?.status).toBe("pending");

    control.commitError = undefined;
    await watcher.pollNow();

    expect(batches).toHaveLength(1);
    expect(state.deposit(txid)?.status).toBe("confirmed");
  });
});

describe("when passes run", () => {
  test("with no tip change a pass waits for sweepMs, then sweeps once", async () => {
    const { view, watcher, credit } = rig();
    await credit();
    await watcher.pollNow();
    const inspect = vi.spyOn(view, "inspect");
    watcher.start();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(inspect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("a tip change starts a pass at once, whatever the last sweep", async () => {
    const { fake, view, watcher, credit } = rig();
    await credit();
    await watcher.pollNow();
    const inspect = vi.spyOn(view, "inspect");
    watcher.start();

    fake.mine();
    await vi.advanceTimersByTimeAsync(TICK);

    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("a refresh of one session does not use up the tip change for the others", async () => {
    const { fake, state, watcher, credit } = rig();
    const mine = await credit(SESSION_KEY);
    const theirs = await credit(OTHER_SESSION_KEY);
    await watcher.pollNow();
    watcher.start();

    fake.mine();
    await watcher.refreshSession(SESSION_KEY);
    await vi.advanceTimersByTimeAsync(TICK);

    expect(state.deposit(mine)?.status).toBe("confirmed");
    expect(state.deposit(theirs)?.status).toBe("confirmed");
  });

  test("overlapping passes commit a change once", async () => {
    const { fake, batches, watcher, credit } = rig();
    await credit();
    fake.mine();

    await Promise.all([watcher.pollNow(), watcher.pollNow(), watcher.refreshSession(SESSION_KEY)]);

    expect(batches).toHaveLength(1);
  });

  test("ticks queue no pass behind one that is still running", async () => {
    const slow = (view: ChainView): ChainView => ({
      tip: () => view.tip(),
      inspect: (txid) => new Promise((resolve) => setTimeout(() => resolve(view.inspect(txid)), 12_000)),
    });
    const { view, watcher, credit } = rig(slow, { sweepMs: TICK });
    await credit();
    const inspect = vi.spyOn(view, "inspect");

    watcher.start();
    await vi.advanceTimersByTimeAsync(TICK * 3 + 1000);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("start() ticks every 5 s, once even when called twice, and stop() ends the ticks", async () => {
    const { view, watcher } = rig();
    await watcher.pollNow();
    const tip = vi.spyOn(view, "tip");

    watcher.start();
    watcher.start();
    await vi.advanceTimersByTimeAsync(TICK - 1);
    expect(tip).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TICK + 1);
    expect(tip).toHaveBeenCalledTimes(2);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(tip).toHaveBeenCalledTimes(2);
  });

  test("the timer does not keep the process alive", () => {
    const { watcher } = rig();
    const interval = vi.spyOn(globalThis, "setInterval");

    watcher.start();

    const timer = interval.mock.results[0]?.value as { hasRef(): boolean } | undefined;
    expect(timer?.hasRef()).toBe(false);
  });
});

describe("lastTip", () => {
  test("is null until a tip has been read, then follows each read", async () => {
    const { fake, watcher, credit } = rig();
    await credit();
    expect(watcher.lastTip()).toBeNull();

    await watcher.pollNow();
    expect(watcher.lastTip()).toBe(1000);

    fake.mine(3);
    await watcher.refreshSession(SESSION_KEY);
    expect(watcher.lastTip()).toBe(1003);

    fake.mine(2);
    watcher.start();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(watcher.lastTip()).toBe(1005);
  });

  test("a tip read by a tick counts even when the pass behind it cannot read the chain", async () => {
    let reads = 0;
    const { fake, log, watcher } = rig((view) => ({
      tip: () => (++reads % 2 === 1 ? view.tip() : Promise.reject(new ChainUnavailableError("flaky"))),
      inspect: (txid) => view.inspect(txid),
    }));
    fake.mine();
    watcher.start();

    await vi.advanceTimersByTimeAsync(TICK);

    expect(watcher.lastTip()).toBe(1001);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("keeps the last tip when a read fails", async () => {
    const { fake, watcher } = rig();
    await watcher.pollNow();

    fake.mine();
    fake.setUnavailable(true);
    await watcher.pollNow();

    expect(watcher.lastTip()).toBe(1000);
  });
});

describe("refreshSession", () => {
  test("two calls within 5 s: the second returns false and makes no inspect", async () => {
    const { view, watcher, credit } = rig();
    await credit();
    const inspect = vi.spyOn(view, "inspect");

    expect(await watcher.refreshSession(SESSION_KEY)).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4999);
    expect(await watcher.refreshSession(SESSION_KEY)).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(await watcher.refreshSession(SESSION_KEY)).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  test("another session is not held back by the first one's refresh, nor does it release it", async () => {
    const { watcher, credit } = rig();
    await credit(SESSION_KEY);
    await credit(OTHER_SESSION_KEY);

    expect(await watcher.refreshSession(SESSION_KEY)).toBe(true);
    expect(await watcher.refreshSession(OTHER_SESSION_KEY)).toBe(true);
    expect(await watcher.refreshSession(SESSION_KEY)).toBe(false);
  });

  test("two concurrent refreshes of one session make one inspect", async () => {
    const { view, watcher, credit } = rig();
    await credit();
    const inspect = vi.spyOn(view, "inspect");

    const results = await Promise.all([watcher.refreshSession(SESSION_KEY), watcher.refreshSession(SESSION_KEY)]);

    expect(results).toEqual([true, false]);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("re-inspects only that session's live deposits and commits what changed", async () => {
    const { fake, view, batches, watcher, credit } = rig();
    const mine = await credit(SESSION_KEY);
    await credit(OTHER_SESSION_KEY);
    fake.mine();
    const inspect = vi.spyOn(view, "inspect");

    expect(await watcher.refreshSession(SESSION_KEY)).toBe(true);

    expect(inspect.mock.calls).toEqual([[mine]]);
    expect(batches).toEqual([
      [{ t: "status", txid: mine, status: "confirmed", minedHeight: 1001, confirmations: 1, deadAtTip: null }],
    ]);
  });

  test("a refresh that cannot read the chain is logged and still returns true", async () => {
    const { fake, log, watcher, credit } = rig();
    await credit();
    fake.setUnavailable(true);

    expect(await watcher.refreshSession(SESSION_KEY)).toBe(true);

    expect(log).toHaveBeenCalledTimes(1);
  });
});
