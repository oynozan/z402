import type { DepositStatus, REASON } from "@z402-net/protocol";

/** A credited deposit, bound to exactly one session */
export interface DepositRecord {
  txid: string;
  sessionKey: string;
  valueZat: bigint;
  zeroConf: boolean;
  expiryHeight: number;
  firstSeenTip: number;
  status: DepositStatus;
  minedHeight: number | null;
  confirmations: number;
  /** Streak of definitive not-found answers, transient and never written to the ledger */
  notFound: { sinceMs: number; sinceTip: number } | null;
  deadAtTip: number | null;
}

export type Evaluation =
  | {
      ok: true;
      valueZat: bigint;
      zeroConf: boolean;
      status: DepositStatus;
      minedHeight: number | null;
      confirmations: number;
      expiryHeight: number;
    }
  | {
      ok: false;
      code: typeof REASON.depositTransparent | typeof REASON.depositMemoMismatch | typeof REASON.depositDead;
    };

/** A dead deposit is re-inspected for this many blocks after it died */
export const DEAD_RECHECK_BLOCKS = 20;

/** A snapshot lists every non-final deposit and this many of the latest final ones */
export const SNAPSHOT_FINAL_KEEP = 4;
