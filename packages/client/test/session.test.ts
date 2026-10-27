import type { SettleResponse } from "@x402/core/types";
import { REASON } from "@z402/protocol";
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { localDeposit, NETWORK, PAY_TO, SEED, snapshot, snapshotDeposit, txid } from "./fixtures.js";

const TX = txid(0xc1);

function newSession(): Session {
  return new Session({ payTo: PAY_TO, network: NETWORK, seed: SEED });
}

function settle(o: Partial<SettleResponse> & { session?: unknown }): SettleResponse {
  const { session, ...rest } = o;
  return {
    success: true,
    transaction: "",
    network: NETWORK,
    ...rest,
    ...(session === undefined ? {} : { extra: { session } }),
  };
}

describe("Session construction", () => {
  it("derives the session key from the seed and starts empty", () => {
    const s = newSession();
    expect(s.sessionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.cumulative).toBe(0n);
    expect(s.nextIndex).toBe(1);
    expect(s.depositsMade).toBe(0);
    expect(s.deposits).toEqual([]);
    expect(s.snapshot).toBeUndefined();
    expect(s.hasPending()).toBe(false);
    expect(s.resendTxid()).toBeUndefined();
  });

  it("is deterministic in the seed", () => {
    expect(newSession().sessionKey).toBe(newSession().sessionKey);
    expect(new Session({ payTo: PAY_TO, network: NETWORK, seed: new Uint8Array(32).fill(8) }).sessionKey).not.toBe(
      newSession().sessionKey,
    );
  });
});

describe("Session.depositDecision", () => {
  it("is inline with no snapshot and no deposits", () => {
    expect(newSession().depositDecision(500n, 100_000n, true)).toBe("inline");
  });

  it("is none with no snapshot but a local sent deposit", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it.each(["sending", "acked", "uncertain"] as const)("is none with no snapshot and a local %s deposit", (state) => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, state));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it.each(["dead", "rejected", "failed"] as const)("is inline with no snapshot and only a %s deposit", (state) => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, state));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("inline");
  });

  it("is inline when headroom is below the price and nothing is pending", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 600n, limit: 1000n }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("inline");
  });

  it("is background when headroom is below the trigger and nothing is pending", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 65_000n, limit: 125_000n }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("background");
  });

  it("is none when headroom is below the trigger but a deposit is pending", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 65_000n, limit: 125_000n, deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.hasPending()).toBe(true);
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it("is none when headroom is below the price but a deposit is pending", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 600n, limit: 1000n, deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it("is none when headroom is below the trigger but a local sent deposit is unacked", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 65_000n, limit: 125_000n }));
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    expect(s.hasPending()).toBe(true);
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it("is none when headroom reaches the trigger", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 25_000n, limit: 125_000n }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
  });

  it("is background when headroom equals the price, and inline just below it", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 500n, limit: 1000n }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("background");
    s.applySnapshot(snapshot({ cumulative: 501n, limit: 1000n }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("inline");
  });

  it("uses the session cumulative, not the snapshot's, for headroom", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ cumulative: 0n, limit: 1000n }));
    s.advanceAmbiguous(600n);
    expect(s.depositDecision(500n, 100_000n, true)).toBe("inline");
  });

  it("is none whenever canDeposit is false", () => {
    const fresh = newSession();
    expect(fresh.depositDecision(500n, 100_000n, false)).toBe("none");

    const short = newSession();
    short.applySnapshot(snapshot({ cumulative: 600n, limit: 1000n }));
    expect(short.depositDecision(500n, 100_000n, false)).toBe("none");

    const low = newSession();
    low.applySnapshot(snapshot({ cumulative: 65_000n, limit: 125_000n }));
    expect(low.depositDecision(500n, 100_000n, false)).toBe("none");
  });
});

describe("Session.hasPending", () => {
  it("sees a pending deposit in the snapshot", () => {
    const s = newSession();
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.hasPending()).toBe(true);
  });

  it.each(["confirmed", "final", "orphaned", "dead"] as const)("ignores a %s snapshot deposit", (status) => {
    const s = newSession();
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, status)] }));
    expect(s.hasPending()).toBe(false);
  });

  it("sees a local sent deposit and ignores the other local states", () => {
    const s = newSession();
    for (const state of ["sending", "acked", "dead", "rejected", "failed", "uncertain"] as const) {
      s.deposits.length = 0;
      s.deposits.push(localDeposit(s.sessionKey, 1, state, TX));
      expect(s.hasPending()).toBe(false);
    }
    s.deposits.length = 0;
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    expect(s.hasPending()).toBe(true);
  });
});

describe("Session.applySnapshot", () => {
  it("resyncs cumulative, even downwards, and stores the snapshot", () => {
    const s = newSession();
    s.cumulative = 9000n;
    const snap = snapshot({ cumulative: 4000n });
    s.applySnapshot(snap);
    expect(s.cumulative).toBe(4000n);
    expect(s.snapshot).toBe(snap);
  });

  it("acks a local deposit the snapshot lists, whatever the status", () => {
    for (const status of ["pending", "confirmed", "final", "orphaned"] as const) {
      const s = newSession();
      s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
      s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, status)] }));
      expect(s.deposits[0]?.state).toBe("acked");
    }
  });

  it("marks a local deposit dead when the snapshot lists it as dead", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "dead")] }));
    expect(s.deposits[0]?.state).toBe("dead");
    expect(s.resendTxid()).toBeUndefined();
  });

  it("leaves local deposits the snapshot does not list alone", () => {
    const s = newSession();
    const other = txid(0xd2);
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX), localDeposit(s.sessionKey, 2, "sending"));
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(other)] }));
    expect(s.deposits.map((d) => d.state)).toEqual(["sent", "sending"]);
  });
});

describe("Session.applySettle", () => {
  it("success with a snapshot sets cumulative from the snapshot", () => {
    const s = newSession();
    const snap = snapshot({ cumulative: 3500n });
    s.applySettle(settle({ session: snap }), 4000n);
    expect(s.cumulative).toBe(3500n);
    expect(s.snapshot).toEqual(snap);
  });

  it("success without a snapshot sets cumulative to the attempted value", () => {
    const s = newSession();
    s.applySettle(settle({}), 1500n);
    expect(s.cumulative).toBe(1500n);
    expect(s.snapshot).toBeUndefined();
  });

  it("success with an invalid snapshot falls back to the attempted value", () => {
    const s = newSession();
    s.applySettle(settle({ session: { cumulativeZat: "7" } }), 1500n);
    expect(s.cumulative).toBe(1500n);
    expect(s.snapshot).toBeUndefined();
  });

  it("marks the deposit acked when transaction equals its txid", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySettle(settle({ transaction: TX }), 500n);
    expect(s.deposits[0]?.state).toBe("acked");
    expect(s.resendTxid()).toBeUndefined();
  });

  it("an empty transaction acks nothing, including a deposit with no txid yet", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX), localDeposit(s.sessionKey, 2, "sending"));
    s.applySettle(settle({ transaction: "" }), 500n);
    expect(s.deposits.map((d) => d.state)).toEqual(["sent", "sending"]);
  });

  it("marks a local deposit dead when the snapshot lists it as dead", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySettle(settle({ session: snapshot({ cumulative: 500n, deposits: [snapshotDeposit(TX, "dead")] }) }), 500n);
    expect(s.deposits[0]?.state).toBe("dead");
  });

  it("the snapshot's dead status wins over a transaction ack", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySettle(settle({ transaction: TX, session: snapshot({ deposits: [snapshotDeposit(TX, "dead")] }) }), 500n);
    expect(s.deposits[0]?.state).toBe("dead");
  });

  it("a failed settle leaves cumulative alone", () => {
    const s = newSession();
    s.cumulative = 2000n;
    s.applySettle(
      settle({ success: false, errorReason: REASON.cumulativeMismatch, session: snapshot({ cumulative: 100n }) }),
      3000n,
    );
    expect(s.cumulative).toBe(2000n);
  });
});

describe("Session.resendTxid", () => {
  it("returns the newest sent deposit", () => {
    const s = newSession();
    const older = txid(0xa1);
    const newer = txid(0xa2);
    s.deposits.push(
      localDeposit(s.sessionKey, 1, "sent", older),
      localDeposit(s.sessionKey, 2, "sent", newer),
      localDeposit(s.sessionKey, 3, "sending"),
    );
    expect(s.resendTxid()).toBe(newer);
  });

  it("skips deposits that are not sent", () => {
    const s = newSession();
    const sent = txid(0xa1);
    s.deposits.push(
      localDeposit(s.sessionKey, 1, "sent", sent),
      localDeposit(s.sessionKey, 2, "dead", txid(0xa2)),
      localDeposit(s.sessionKey, 3, "rejected", txid(0xa3)),
      localDeposit(s.sessionKey, 4, "acked", txid(0xa4)),
    );
    expect(s.resendTxid()).toBe(sent);
  });

  it("is undefined when nothing is sent", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "uncertain"), localDeposit(s.sessionKey, 2, "failed"));
    expect(s.resendTxid()).toBeUndefined();
  });

  it("stops once the snapshot lists the deposit (settle transaction empty)", () => {
    for (const status of ["pending", "confirmed"] as const) {
      const s = newSession();
      s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
      expect(s.resendTxid()).toBe(TX);
      s.applySettle(
        settle({ transaction: "", session: snapshot({ cumulative: 500n, deposits: [snapshotDeposit(TX, status)] }) }),
        500n,
      );
      expect(s.resendTxid()).toBeUndefined();
    }
  });

  it("keeps returning the txid while the snapshot does not list it and transaction is empty", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySettle(settle({ transaction: "", session: snapshot({ cumulative: 500n, deposits: [] }) }), 500n);
    expect(s.resendTxid()).toBe(TX);
  });
});

describe("Session.markDead and markRejected", () => {
  it("markDead stops the resend", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.markDead(TX);
    expect(s.deposits[0]?.state).toBe("dead");
    expect(s.resendTxid()).toBeUndefined();
    expect(s.hasPending()).toBe(false);
  });

  it("markRejected stops the resend", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.markRejected(TX);
    expect(s.deposits[0]?.state).toBe("rejected");
    expect(s.resendTxid()).toBeUndefined();
    expect(s.hasPending()).toBe(false);
  });

  it("an unknown txid changes nothing", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.markDead(txid(0xee));
    s.markRejected(txid(0xee));
    expect(s.deposits[0]?.state).toBe("sent");
  });
});

describe("Session.advanceAmbiguous", () => {
  it("raises cumulative to the attempted value", () => {
    const s = newSession();
    s.cumulative = 2000n;
    s.advanceAmbiguous(3000n);
    expect(s.cumulative).toBe(3000n);
  });

  it("never lowers cumulative", () => {
    const s = newSession();
    s.cumulative = 4000n;
    s.advanceAmbiguous(3000n);
    expect(s.cumulative).toBe(4000n);
  });
});

describe("Session terminal states (dead and rejected never come back)", () => {
  it.each(["dead", "rejected"] as const)("a %s deposit stays put when a snapshot lists it as pending", (state) => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, state, TX));
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.deposits[0]?.state).toBe(state);
    expect(s.resendTxid()).toBeUndefined();
  });

  it("a rejected deposit stays rejected when a snapshot lists it as dead", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "rejected", TX));
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "dead")] }));
    expect(s.deposits[0]?.state).toBe("rejected");
  });

  it.each(["dead", "rejected"] as const)("a settle transaction does not ack a %s deposit", (state) => {
    for (const success of [true, false]) {
      const s = newSession();
      s.deposits.push(localDeposit(s.sessionKey, 1, state, TX));
      s.applySettle(settle({ success, transaction: TX }), 500n);
      expect(s.deposits[0]?.state).toBe(state);
    }
  });
});

describe("Session failed-settle ack (protocol.md §7.3)", () => {
  it("a failed settle whose transaction is our txid acks that deposit, so it is not resent", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySettle(settle({ success: false, errorReason: REASON.cumulativeMismatch, transaction: TX }), 500n);
    expect(s.deposits[0]?.state).toBe("acked");
    expect(s.resendTxid()).toBeUndefined();
  });
});

describe("Session.hasPending with local terminal states", () => {
  it.each(["dead", "rejected"] as const)("ignores a snapshot pending entry whose txid is locally %s", (state) => {
    const s = newSession();
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.hasPending()).toBe(true);
    s.deposits.push(localDeposit(s.sessionKey, 1, state, TX));
    expect(s.hasPending()).toBe(false);
  });

  it("still sees another pending entry next to a locally dead one", () => {
    const s = newSession();
    const other = txid(0xd2);
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySnapshot(snapshot({ deposits: [snapshotDeposit(TX, "pending"), snapshotDeposit(other, "pending")] }));
    s.markDead(TX);
    expect(s.hasPending()).toBe(true);
  });

  it("a locally dead deposit no longer makes the decision none", () => {
    const s = newSession();
    s.deposits.push(localDeposit(s.sessionKey, 1, "sent", TX));
    s.applySnapshot(snapshot({ cumulative: 600n, limit: 1000n, deposits: [snapshotDeposit(TX, "pending")] }));
    expect(s.depositDecision(500n, 100_000n, true)).toBe("none");
    s.markDead(TX);
    expect(s.depositDecision(500n, 100_000n, true)).toBe("inline");
  });
});
