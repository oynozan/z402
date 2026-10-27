import type { DepositRecord } from "../../src/core/types.js";

export const SESSION_KEY = "ab".repeat(32);
export const OTHER_SESSION_KEY = "cd".repeat(32);
export const TIP = 4547300;
export const W = 100000n;

/** A 64-hex txid built from a small number, so expected values stay readable */
export const txidOf = (n: number): string => n.toString(16).padStart(64, "0");

let next = 1;

/** A pending, zero-conf deposit of one window with a fresh txid, unless `over` says otherwise */
export function record(over: Partial<DepositRecord> = {}): DepositRecord {
  return {
    txid: txidOf(next++),
    sessionKey: SESSION_KEY,
    valueZat: W,
    zeroConf: true,
    expiryHeight: TIP + 40,
    firstSeenTip: TIP,
    status: "pending",
    minedHeight: null,
    confirmations: 0,
    notFound: null,
    deadAtTip: null,
    ...over,
  };
}
