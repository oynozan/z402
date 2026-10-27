import type { Terms } from "./terms.js";

export const DEPOSIT_STATUSES = ["pending", "confirmed", "final", "orphaned", "dead"] as const;

export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export interface RampDeposit {
  valueZat: bigint;
  status: DepositStatus;
  zeroConf: boolean;
}

export interface Ramp {
  confirmedZat: bigint;
  pendingZat: bigint;
  creditZat: bigint;
  limitZat: bigint;
}

const BPS_DENOMINATOR = 10000n;

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** The credit limit of protocol.md section 6. `orphaned` and `dead` deposits count nowhere. */
export function computeLimit(deposits: readonly RampDeposit[], terms: Terms): Ramp {
  let confirmedZat = 0n;
  let pendingSum = 0n;
  for (const deposit of deposits) {
    if (deposit.status === "confirmed" || deposit.status === "final") {
      confirmedZat += deposit.valueZat;
    } else if (deposit.status === "pending" && deposit.zeroConf) {
      pendingSum += deposit.valueZat;
    }
  }
  const pendingZat = min(terms.windowZat, pendingSum);
  const creditZat = min(terms.creditCapZat, (confirmedZat * BigInt(terms.creditRatioBps)) / BPS_DENOMINATOR);
  return { confirmedZat, pendingZat, creditZat, limitZat: confirmedZat + pendingZat + creditZat };
}

/** `referenceTip` is the tip when the facilitator first resolved the deposit (protocol.md section 5.3). */
export function zeroConfEligible(a: {
  valueZat: bigint;
  expiryHeight: number;
  referenceTip: number;
  terms: Terms;
}): boolean {
  return (
    a.valueZat >= a.terms.windowZat &&
    (a.expiryHeight === 0 || a.expiryHeight - a.referenceTip >= a.terms.zeroConfMinExpiryBlocks)
  );
}

/** The mined block is the first confirmation. A mined height can run ahead of the cached tip. */
export function confirmations(minedHeight: number, tip: number): number {
  return Math.max(tip, minedHeight) - minedHeight + 1;
}

/** Zebra evicts at `tip >= expiryHeight`, and block `tip + 1` cannot include the transaction. */
export function isDepositDead(d: { minedHeight: number | null; expiryHeight: number; tip: number }): boolean {
  return d.minedHeight === null && d.expiryHeight !== 0 && d.tip >= d.expiryHeight;
}

/** The mismatch check comes first: the limit is only consulted for a well-formed increment. */
export function checkVoucher(v: {
  cLast: bigint;
  cNew: bigint;
  price: bigint;
  limit: bigint;
}): "ok" | "cumulative_mismatch" | "over_limit" {
  if (v.cNew - v.cLast < v.price) return "cumulative_mismatch";
  if (v.cNew > v.limit) return "over_limit";
  return "ok";
}
