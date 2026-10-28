import {
  confirmations,
  FINAL_CONFIRMATIONS,
  isDepositDead,
  parseDepositMemo,
  REASON,
  zeroConfEligible,
  type FoundInspection,
  type Terms,
} from "@z402/protocol";
import type { DepositRecord, Evaluation } from "./types.js";

/** Where an inspection puts a deposit at the tip, dead when it is unmined past its expiry */
export function chainPosition(
  at: Pick<FoundInspection, "location" | "minedHeight" | "expiryHeight">,
  tip: number,
): Pick<DepositRecord, "status" | "minedHeight" | "confirmations"> {
  const minedHeight = at.location === "mined" ? at.minedHeight : null;
  if (isDepositDead({ minedHeight, expiryHeight: at.expiryHeight, tip })) {
    return { status: "dead", minedHeight: null, confirmations: 0 };
  }
  if (minedHeight !== null) {
    const depth = confirmations(minedHeight, tip);
    return { status: depth >= FINAL_CONFIRMATIONS ? "final" : "confirmed", minedHeight, confirmations: depth };
  }
  return { status: at.location === "orphaned" ? "orphaned" : "pending", minedHeight: null, confirmations: 0 };
}

/** Judges death and depth at `tip`, and zero-conf at `referenceTip`, the tip of the first sighting (protocol §5.3) */
export function evaluateDeposit(
  insp: FoundInspection,
  sessionKey: string,
  terms: Terms,
  tip: number,
  referenceTip = tip,
): Evaluation {
  if (insp.hasTransparent) return { ok: false, code: REASON.depositTransparent };
  // Answered like a wrong memo, so the code never tells whether a transaction pays the merchant
  if (insp.outputs.length === 0) return { ok: false, code: REASON.depositMemoMismatch };

  const matching = insp.outputs.filter(
    (out) => out.memo !== null && parseDepositMemo(out.memo)?.sessionKey === sessionKey,
  );
  if (matching.length === 0) return { ok: false, code: REASON.depositMemoMismatch };

  const at = chainPosition(insp, tip);
  if (at.status === "dead") return { ok: false, code: REASON.depositDead };

  const valueZat = matching.reduce((sum, out) => sum + out.valueZat, 0n);
  const zeroConf = zeroConfEligible({ valueZat, expiryHeight: insp.expiryHeight, referenceTip, terms });
  return { ok: true, valueZat, zeroConf, ...at, expiryHeight: insp.expiryHeight };
}
