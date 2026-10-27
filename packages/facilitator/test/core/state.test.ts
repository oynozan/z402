import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TERMS, type DepositStatus, type FoundInspection, type TxInspection } from "@z402/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { buildSnapshot } from "../../src/core/snapshot.js";
import { commit, FacilitatorState } from "../../src/core/state.js";
import { observe } from "../../src/core/transitions.js";
import { depositEvent, statusEvent, unreadableEvents, voucherEvent } from "./events.js";
import { OTHER_SESSION_KEY as OTHER, SESSION_KEY as K, TIP, txidOf } from "./records.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "z402-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function stateWith(...events: LedgerEvent[]): FacilitatorState {
  const state = new FacilitatorState();
  for (const e of events) state.apply(e);
  return state;
}

const KEYS = [K, OTHER];
const TXIDS = [1, 2, 3, 4].map(txidOf);
const STATUSES: DepositStatus[] = ["pending", "confirmed", "final", "orphaned", "dead"];

/** Everything an observer can read from a state, for comparing two states */
function view(state: FacilitatorState) {
  return {
    deposits: TXIDS.map((txid) => state.deposit(txid)),
    sessions: KEYS.map((key) => state.session(key)),
    credited: KEYS.map((key) => state.depositsOf(key).map((d) => d.txid)),
    live: state.liveDeposits(TIP).map((d) => d.txid),
  };
}

/** The message `run` throws, or null when it does not throw */
function refusal(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Events over a small universe of txids and sessions, so that collisions and refusals are common */
function randomEvent(next: () => number): () => LedgerEvent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  return () => {
    const kind = pick(["deposit", "voucher", "status"] as const);
    if (kind === "deposit") {
      return depositEvent({ txid: pick(TXIDS), sessionKey: pick(KEYS), status: pick(STATUSES) });
    }
    if (kind === "voucher") {
      return voucherEvent({ sessionKey: pick(KEYS), cumulativeZat: pick(["0", "100", "500", "5000"]) });
    }
    return statusEvent({
      txid: pick(TXIDS),
      status: pick(STATUSES),
      minedHeight: pick([null, TIP]),
      confirmations: pick([0, 3]),
      deadAtTip: pick([null, TIP]),
    });
  };
}

describe("FacilitatorState deposits", () => {
  test("after a deposit event, ownerOf(txid) === key", () => {
    expect(stateWith(depositEvent()).ownerOf(txidOf(1))).toBe(K);
  });

  test("a deposit event becomes a record with amounts as bigint and no transient state", () => {
    expect(stateWith(depositEvent()).deposit(txidOf(1))).toEqual({
      txid: txidOf(1),
      sessionKey: K,
      valueZat: 100000n,
      zeroConf: true,
      expiryHeight: TIP + 40,
      firstSeenTip: TIP,
      status: "pending",
      minedHeight: null,
      confirmations: 0,
      notFound: null,
      deadAtTip: null,
    });
  });

  test("an unknown txid has no owner and no record", () => {
    const state = stateWith(depositEvent());
    expect(state.ownerOf(txidOf(2))).toBeUndefined();
    expect(state.deposit(txidOf(2))).toBeUndefined();
  });

  test("a deposit for a txid owned by another key throws and changes nothing", () => {
    const state = stateWith(depositEvent());
    expect(() => state.apply(depositEvent({ sessionKey: OTHER, valueZat: "1" }))).toThrow(/already credited/);
    expect(state.ownerOf(txidOf(1))).toBe(K);
    expect(state.deposit(txidOf(1))?.valueZat).toBe(100000n);
    expect(state.depositsOf(OTHER)).toEqual([]);
  });

  test("the same deposit twice throws, so a txid is credited once", () => {
    const state = stateWith(depositEvent());
    expect(() => state.apply(depositEvent())).toThrow(/already credited/);
    expect(state.depositsOf(K)).toHaveLength(1);
  });

  test("depositsOf lists one session's deposits in the order they were credited", () => {
    const state = stateWith(
      depositEvent({ txid: txidOf(3) }),
      depositEvent({ txid: txidOf(1), sessionKey: OTHER }),
      depositEvent({ txid: txidOf(2) }),
      depositEvent({ txid: txidOf(4), sessionKey: OTHER }),
    );
    expect(state.depositsOf(K).map((d) => d.txid)).toEqual([txidOf(3), txidOf(2)]);
    expect(state.depositsOf(OTHER).map((d) => d.txid)).toEqual([txidOf(1), txidOf(4)]);
    expect(state.depositsOf("ef".repeat(32))).toEqual([]);
  });

  test.each([
    ["a credited record", [depositEvent()], "pending"],
    ["a record moved by a status event", [depositEvent(), statusEvent()], "confirmed"],
  ])("%s cannot be edited behind the state's back", (_what, events, status) => {
    const state = stateWith(...events);
    const record = must(state.deposit(txidOf(1)));
    expect(() => {
      record.status = "final";
    }).toThrow(TypeError);
    expect(must(state.depositsOf(K)[0]).status).toBe(status);
  });
});

describe("FacilitatorState vouchers", () => {
  test("after a voucher event, cLast === 5000n", () => {
    expect(stateWith(voucherEvent()).session(K)).toEqual({ sessionKey: K, cLast: 5000n });
  });

  test("a session with no voucher is unknown, even with a deposit", () => {
    expect(stateWith(depositEvent()).session(K)).toBeUndefined();
  });

  test("a voucher with a lower cumulative than cLast throws and changes nothing", () => {
    const state = stateWith(voucherEvent({ cumulativeZat: "5000" }));
    expect(() => state.apply(voucherEvent({ cumulativeZat: "4999" }))).toThrow(/below/);
    expect(state.session(K)?.cLast).toBe(5000n);
  });

  test("a voucher at the same cumulative is accepted", () => {
    const state = stateWith(voucherEvent({ cumulativeZat: "5000" }));
    state.apply(voucherEvent({ cumulativeZat: "5000" }));
    expect(state.session(K)?.cLast).toBe(5000n);
  });

  test("a higher voucher raises cLast", () => {
    const state = stateWith(voucherEvent({ cumulativeZat: "5000" }));
    state.apply(voucherEvent({ cumulativeZat: "5500" }));
    expect(state.session(K)?.cLast).toBe(5500n);
  });

  test("sessions keep separate cumulatives", () => {
    const state = stateWith(
      voucherEvent({ cumulativeZat: "5000" }),
      voucherEvent({ sessionKey: OTHER, cumulativeZat: "10" }),
    );
    expect(state.session(K)?.cLast).toBe(5000n);
    expect(state.session(OTHER)?.cLast).toBe(10n);
  });

  test("the session handed out is a copy", () => {
    const state = stateWith(voucherEvent());
    must(state.session(K)).cLast = 1n;
    expect(state.session(K)?.cLast).toBe(5000n);
  });
});

describe("FacilitatorState status events", () => {
  test("a status event updates status, height and confirmations only", () => {
    const state = stateWith(
      depositEvent(),
      statusEvent({ status: "confirmed", minedHeight: TIP + 1, confirmations: 3 }),
    );
    expect(state.deposit(txidOf(1))).toEqual({
      txid: txidOf(1),
      sessionKey: K,
      valueZat: 100000n,
      zeroConf: true,
      expiryHeight: TIP + 40,
      firstSeenTip: TIP,
      status: "confirmed",
      minedHeight: TIP + 1,
      confirmations: 3,
      notFound: null,
      deadAtTip: null,
    });
  });

  test("a status event carries deadAtTip", () => {
    const state = stateWith(
      depositEvent(),
      statusEvent({ status: "dead", minedHeight: null, confirmations: 0, deadAtTip: TIP + 5 }),
    );
    expect(state.deposit(txidOf(1))).toMatchObject({ status: "dead", minedHeight: null, deadAtTip: TIP + 5 });
  });

  test("a status event keeps the deposit's place in its session's list", () => {
    const state = stateWith(depositEvent({ txid: txidOf(1) }), depositEvent({ txid: txidOf(2) }));
    state.apply(statusEvent({ txid: txidOf(1) }));
    expect(state.depositsOf(K).map((d) => [d.txid, d.status])).toEqual([
      [txidOf(1), "confirmed"],
      [txidOf(2), "pending"],
    ]);
  });

  test("a status event for an unknown txid throws", () => {
    expect(() => new FacilitatorState().apply(statusEvent())).toThrow(/unknown deposit/);
  });
});

describe("FacilitatorState.liveDeposits", () => {
  test.each<[DepositStatus, number | null, boolean]>([
    ["pending", null, true],
    ["confirmed", null, true],
    ["orphaned", null, true],
    ["final", null, false],
    ["dead", TIP - 20, true],
    ["dead", TIP - 21, false],
    ["dead", null, false],
  ])("a %s deposit (deadAtTip %s) is live: %s", (status, deadAtTip, live) => {
    const state = stateWith(depositEvent(), statusEvent({ status, deadAtTip }));
    expect(state.liveDeposits(TIP).map((d) => d.txid)).toEqual(live ? [txidOf(1)] : []);
  });

  test("live deposits of every session come back in credited order", () => {
    const state = stateWith(
      depositEvent({ txid: txidOf(1) }),
      depositEvent({ txid: txidOf(2), sessionKey: OTHER }),
      depositEvent({ txid: txidOf(3) }),
      statusEvent({ txid: txidOf(2), status: "final", confirmations: 10 }),
    );
    expect(state.liveDeposits(TIP).map((d) => d.txid)).toEqual([txidOf(1), txidOf(3)]);
  });
});

describe("commit", () => {
  test("appends to the ledger and applies to the state", () => {
    const ledger = new Ledger();
    const state = new FacilitatorState();
    commit(ledger, state, [depositEvent(), voucherEvent()]);
    expect(ledger.replay()).toEqual([depositEvent(), voucherEvent()]);
    expect(state.ownerOf(txidOf(1))).toBe(K);
    expect(state.session(K)?.cLast).toBe(5000n);
  });

  test("is synchronous: the state is current as soon as it returns", () => {
    const state = new FacilitatorState();
    expect(commit(new Ledger(), state, [voucherEvent()])).toBeUndefined();
    expect(state.session(K)?.cLast).toBe(5000n);
    expect(commit.constructor.name).toBe("Function");
  });

  test("a failing append leaves the state untouched", () => {
    const state = new FacilitatorState();
    const ledger = new Ledger(dir);
    expect(() => commit(ledger, state, [depositEvent(), voucherEvent()])).toThrow();
    expect(state.ownerOf(txidOf(1))).toBeUndefined();
    expect(state.session(K)).toBeUndefined();
  });

  test("an event the state refuses surfaces as a throw", () => {
    const state = stateWith(voucherEvent({ cumulativeZat: "5000" }));
    expect(() => commit(new Ledger(), state, [voucherEvent({ cumulativeZat: "100" })])).toThrow(/below/);
  });

  test("committing nothing changes nothing", () => {
    const ledger = new Ledger();
    commit(ledger, new FacilitatorState(), []);
    expect(ledger.replay()).toEqual([]);
  });
});

describe.each<[string, () => Ledger]>([
  ["file", () => new Ledger(join(dir, "ledger.jsonl"))],
  ["memory", () => new Ledger()],
])("commit refuses a bad batch before writing, with a %s ledger", (_kind, makeLedger) => {
  test("a two-event batch whose second event is refused writes nothing and applies nothing", () => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    commit(ledger, state, [voucherEvent({ cumulativeZat: "5000" })]);
    const written = ledger.replay();

    expect(() => commit(ledger, state, [depositEvent(), voucherEvent({ cumulativeZat: "100" })])).toThrow(/below/);

    expect(ledger.replay()).toEqual(written);
    expect(state.ownerOf(txidOf(1))).toBeUndefined();
    expect(state.depositsOf(K)).toEqual([]);
    expect(state.session(K)?.cLast).toBe(5000n);
  });

  test("a batch that credits one txid twice is refused whole", () => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    expect(() => commit(ledger, state, [depositEvent(), depositEvent()])).toThrow(/already credited/);
    expect(ledger.replay()).toEqual([]);
    expect(state.ownerOf(txidOf(1))).toBeUndefined();
  });

  test("a second voucher below the first in one batch is refused whole", () => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    const batch = [voucherEvent({ cumulativeZat: "5000" }), voucherEvent({ cumulativeZat: "4000" })];
    expect(() => commit(ledger, state, batch)).toThrow(/below/);
    expect(ledger.replay()).toEqual([]);
    expect(state.session(K)).toBeUndefined();
  });

  test("a status for a deposit nobody credited is refused with the batch it came in", () => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    const batch = [depositEvent(), statusEvent({ txid: txidOf(2) })];
    expect(() => commit(ledger, state, batch)).toThrow(/unknown deposit/);
    expect(ledger.replay()).toEqual([]);
    expect(state.ownerOf(txidOf(1))).toBeUndefined();
  });

  test("a deposit and its status in one batch are accepted together", () => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    commit(ledger, state, [depositEvent(), statusEvent()]);
    expect(ledger.replay()).toEqual([depositEvent(), statusEvent()]);
    expect(state.deposit(txidOf(1))?.status).toBe("confirmed");
  });

  test.each(unreadableEvents)("a batch ending in %s is refused before anything is written", (_what, bad) => {
    const ledger = makeLedger();
    const state = new FacilitatorState();
    const batch = [voucherEvent(), bad as LedgerEvent];
    expect(() => commit(ledger, state, batch)).toThrow(/event 2 is not a ledger event/);
    expect(ledger.replay()).toEqual([]);
    expect(state.session(K)).toBeUndefined();
  });
});

describe("commit and the ledger file", () => {
  const path = () => join(dir, "ledger.jsonl");

  test("a refused first batch leaves no file behind", () => {
    const batch = [depositEvent(), statusEvent({ txid: txidOf(2) })];
    expect(() => commit(new Ledger(path()), new FacilitatorState(), batch)).toThrow();
    expect(existsSync(path())).toBe(false);
  });

  test("a refused batch leaves the file byte for byte as it was", () => {
    const ledger = new Ledger(path());
    const state = new FacilitatorState();
    commit(ledger, state, [voucherEvent({ cumulativeZat: "5000" })]);
    const before = readFileSync(path(), "utf8");
    expect(() => commit(ledger, state, [depositEvent(), voucherEvent({ cumulativeZat: "100" })])).toThrow(/below/);
    expect(readFileSync(path(), "utf8")).toBe(before);
  });

  test("a restart after a refused batch replays cleanly into the same state", () => {
    const ledger = new Ledger(path());
    const live = new FacilitatorState();
    commit(ledger, live, [depositEvent(), voucherEvent({ cumulativeZat: "5000" })]);
    expect(() => commit(ledger, live, [statusEvent(), voucherEvent({ cumulativeZat: "10" })])).toThrow(/below/);

    const restarted = stateWith(...new Ledger(path()).replay());
    expect(view(restarted)).toEqual(view(live));
    expect(restarted.deposit(txidOf(1))?.status).toBe("pending");
  });
});

describe("FacilitatorState.check", () => {
  test("a valid batch passes and changes nothing", () => {
    const state = new FacilitatorState();
    expect(state.check([depositEvent(), statusEvent(), voucherEvent()])).toBeUndefined();
    expect(view(state)).toEqual(view(new FacilitatorState()));
  });

  test("an empty batch passes", () => {
    expect(() => new FacilitatorState().check([])).not.toThrow();
  });

  test("it does not modify the batch it is given", () => {
    const batch = Object.freeze([depositEvent(), voucherEvent()]);
    expect(() => new FacilitatorState().check(batch)).not.toThrow();
    expect(batch).toEqual([depositEvent(), voucherEvent()]);
  });

  test("a deposit already credited in the state is refused", () => {
    expect(() => stateWith(depositEvent()).check([depositEvent()])).toThrow(/already credited/);
  });

  test("a deposit credited earlier in the batch is already credited for the next event", () => {
    expect(() => new FacilitatorState().check([depositEvent(), depositEvent({ sessionKey: OTHER })])).toThrow(
      /already credited/,
    );
  });

  test("a voucher is judged against the cumulative the batch has already reached", () => {
    const state = stateWith(voucherEvent({ cumulativeZat: "100" }));
    const pair = (second: string) => [voucherEvent({ cumulativeZat: "5000" }), voucherEvent({ cumulativeZat: second })];
    expect(() => state.check(pair("4999"))).toThrow(/below/);
    expect(() => state.check(pair("5000"))).not.toThrow();
  });

  test("a status may follow the deposit it moves in the same batch, and not precede it", () => {
    expect(() => new FacilitatorState().check([depositEvent(), statusEvent()])).not.toThrow();
    expect(() => new FacilitatorState().check([statusEvent(), depositEvent()])).toThrow(/unknown deposit/);
  });

  test.each(unreadableEvents)("%s is refused with its position in the batch", (_what, bad) => {
    expect(() => new FacilitatorState().check([voucherEvent(), bad as LedgerEvent])).toThrow(
      /event 2 is not a ledger event/,
    );
  });

  test("it throws exactly what applying the batch one event at a time throws", () => {
    const next = rng(20261027);
    const event = randomEvent(next);
    let accepted = 0;
    let refused = 0;
    for (let trial = 0; trial < 400; trial++) {
      const history: LedgerEvent[] = [];
      const state = new FacilitatorState();
      for (let i = 0; i < 6; i++) {
        const e = event();
        if (refusal(() => state.apply(e)) === null) history.push(e);
      }
      const batch = Array.from({ length: 1 + Math.floor(next() * 4) }, event);

      const expected = refusal(() => {
        const reference = stateWith(...history);
        for (const e of batch) reference.apply(e);
      });
      expect(refusal(() => state.check(batch))).toBe(expected);
      expect(view(state)).toEqual(view(stateWith(...history)));
      if (expected === null) accepted++;
      else refused++;
    }
    expect(accepted).toBeGreaterThan(40);
    expect(refused).toBeGreaterThan(40);
  });
});

describe("commit under random batches", () => {
  test("whatever it is given, the file replays into exactly the live state", () => {
    const next = rng(7);
    const event = randomEvent(next);
    const path = join(dir, "ledger.jsonl");
    const ledger = new Ledger(path);
    const live = new FacilitatorState();
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      const batch = Array.from({ length: 1 + Math.floor(next() * 3) }, event);
      if (refusal(() => commit(ledger, live, batch)) !== null) refused++;
      expect(view(stateWith(...new Ledger(path).replay()))).toEqual(view(live));
    }
    expect(refused).toBeGreaterThan(30);
  });
});

describe("event sourcing", () => {
  const found = (
    location: FoundInspection["location"],
    minedHeight: number | null,
    expiryHeight: number,
  ): FoundInspection => ({
    found: true,
    txid: txidOf(1),
    location,
    minedHeight,
    expiryHeight,
    hasTransparent: false,
    outputs: [],
  });

  test("live == replay: the snapshot of a live state equals the snapshot of a state rebuilt from the file", () => {
    const path = join(dir, "ledger.jsonl");
    const ledger = new Ledger(path);
    const live = new FacilitatorState();
    const write = (...events: LedgerEvent[]) => commit(ledger, live, events);
    const look = (txid: string, answer: TxInspection, tip: number) => {
      const next = observe(must(live.deposit(txid)), answer, tip, 1_700_000_000_000);
      write({
        t: "status",
        txid,
        status: next.status,
        minedHeight: next.minedHeight,
        confirmations: next.confirmations,
        deadAtTip: next.deadAtTip,
      });
    };

    write(depositEvent({ txid: txidOf(1) }), voucherEvent({ cumulativeZat: "500" }));
    write(depositEvent({ txid: txidOf(2) }), voucherEvent({ cumulativeZat: "1000" }));
    write(depositEvent({ txid: txidOf(3) }));
    write(depositEvent({ txid: txidOf(4), expiryHeight: TIP + 5 }));
    write(
      depositEvent({ txid: txidOf(5), sessionKey: OTHER, valueZat: "50000", zeroConf: false }),
      voucherEvent({ sessionKey: OTHER, cumulativeZat: "100" }),
    );
    look(txidOf(1), found("mined", TIP + 1, TIP + 40), TIP + 1);
    look(txidOf(3), found("orphaned", null, TIP + 40), TIP + 2);
    look(txidOf(4), found("mempool", null, TIP + 5), TIP + 5);
    look(txidOf(1), found("mined", TIP + 1, TIP + 40), TIP + 10);

    const replayed = new FacilitatorState();
    for (const e of new Ledger(path).replay()) replayed.apply(e);

    const tip = TIP + 10;
    const snapshot = (state: FacilitatorState, key: string) =>
      buildSnapshot({
        sessionKey: key,
        cumulativeZat: state.session(key)?.cLast ?? 0n,
        deposits: state.depositsOf(key),
        terms: DEMO_TERMS,
        tip,
      });

    expect(snapshot(live, K)).toMatchObject({
      cumulativeZat: "1000",
      limitZat: "225000",
      headroomZat: "224000",
      confirmedZat: "100000",
      pendingZat: "100000",
      creditZat: "25000",
    });
    expect(snapshot(live, K).deposits.map((d) => [d.txid, d.status, d.confirmations])).toEqual([
      [txidOf(1), "final", 10],
      [txidOf(2), "pending", 0],
      [txidOf(3), "orphaned", 0],
      [txidOf(4), "dead", 0],
    ]);
    expect(snapshot(live, OTHER)).toMatchObject({ limitZat: "0", headroomZat: "0", cumulativeZat: "100" });

    expect(snapshot(replayed, K)).toEqual(snapshot(live, K));
    expect(snapshot(replayed, OTHER)).toEqual(snapshot(live, OTHER));
    expect(replayed.depositsOf(K)).toEqual(live.depositsOf(K));
    expect(live.liveDeposits(tip).map((d) => d.txid)).toEqual([txidOf(2), txidOf(3), txidOf(4), txidOf(5)]);
    expect(replayed.liveDeposits(tip)).toEqual(live.liveDeposits(tip));
  });
});
