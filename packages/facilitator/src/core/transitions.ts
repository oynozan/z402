import {
  isDepositDead,
  NOT_FOUND_DEAD_BLOCKS,
  NOT_FOUND_DEAD_MS,
  type FoundInspection,
  type TxInspection,
} from "@z402/protocol";
import { chainPosition } from "./evaluate.js";
import { DEAD_RECHECK_BLOCKS, type DepositRecord } from "./types.js";

/** The deposit after one more look at the chain, as a new record */
export function observe(rec: DepositRecord, obs: TxInspection, tip: number, nowMs: number): DepositRecord {
  // Final is irreversible and never polled
  if (rec.status === "final") return { ...rec };
  return obs.found ? seen(rec, obs, tip) : missing(rec, tip, nowMs);
}

function seen(rec: DepositRecord, obs: FoundInspection, tip: number): DepositRecord {
  const at = chainPosition(
    { location: obs.location, minedHeight: obs.minedHeight, expiryHeight: rec.expiryHeight },
    tip,
  );
  if (rec.status !== "dead") {
    return { ...rec, ...at, deadAtTip: at.status === "dead" ? tip : null, notFound: null };
  }
  // A dead deposit is only ever revived as confirmed, within the recheck window
  const revived = at.minedHeight !== null && rec.deadAtTip !== null && tip - rec.deadAtTip <= DEAD_RECHECK_BLOCKS;
  return revived ? { ...rec, ...at, status: "confirmed", deadAtTip: null, notFound: null } : { ...rec };
}

function missing(rec: DepositRecord, tip: number, nowMs: number): DepositRecord {
  if (rec.status === "dead") return { ...rec };

  const streak = rec.notFound ?? { sinceMs: nowMs, sinceTip: tip };
  const expired = isDepositDead({ minedHeight: null, expiryHeight: rec.expiryHeight, tip });
  const matured = nowMs - streak.sinceMs >= NOT_FOUND_DEAD_MS && tip - streak.sinceTip >= NOT_FOUND_DEAD_BLOCKS;
  if (expired || matured) {
    return { ...rec, status: "dead", minedHeight: null, confirmations: 0, deadAtTip: tip, notFound: null };
  }
  return { ...rec, notFound: streak };
}
