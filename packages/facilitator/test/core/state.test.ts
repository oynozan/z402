import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TERMS, type DepositStatus, type FoundInspection, type TxInspection } from "@z402/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { buildSnapshot } from "../../src/core/snapshot.js";
import { commit, FacilitatorState } from "../../src/core/state.js";
import { observe } from "../../src/core/transitions.js";
import { depositEvent, statusEvent, voucherEvent } from "./events.js";
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
