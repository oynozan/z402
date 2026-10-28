import { computeLimit, type SessionSnapshot, type SnapshotDeposit, type Terms } from "@z402/protocol";
import { SNAPSHOT_FINAL_KEEP, type DepositRecord } from "./types.js";

export function buildSnapshot(a: {
  sessionKey: string;
  cumulativeZat: bigint;
  /** What the limit counts, each deposit as judged at the tip */
  deposits: DepositRecord[];
  /** What the snapshot lists, `deposits` unless given */
  shown?: DepositRecord[];
  terms: Terms;
  tip: number;
}): SessionSnapshot {
  const ramp = computeLimit(
    a.deposits.map(({ valueZat, status, zeroConf }) => ({ valueZat, status, zeroConf })),
    a.terms,
  );
  const headroomZat = ramp.limitZat > a.cumulativeZat ? ramp.limitZat - a.cumulativeZat : 0n;
  return {
    sessionKey: a.sessionKey,
    cumulativeZat: a.cumulativeZat.toString(),
    limitZat: ramp.limitZat.toString(),
    headroomZat: headroomZat.toString(),
    confirmedZat: ramp.confirmedZat.toString(),
    pendingZat: ramp.pendingZat.toString(),
    creditZat: ramp.creditZat.toString(),
    tip: a.tip,
    deposits: listed(a.shown ?? a.deposits).map(snapshotDeposit),
  };
}

function listed(deposits: DepositRecord[]): DepositRecord[] {
  let finals = 0;
  const kept: DepositRecord[] = [];
  for (const deposit of deposits.toReversed()) {
    if (deposit.status === "final" && ++finals > SNAPSHOT_FINAL_KEEP) continue;
    kept.push(deposit);
  }
  return kept.reverse();
}

function snapshotDeposit(d: DepositRecord): SnapshotDeposit {
  return {
    txid: d.txid,
    valueZat: d.valueZat.toString(),
    status: d.status,
    confirmations: d.confirmations,
    expiryHeight: d.expiryHeight,
    zeroConf: d.zeroConf,
  };
}
