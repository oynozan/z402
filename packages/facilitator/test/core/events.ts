import type { LedgerEvent } from "../../src/core/ledger.js";
import { SESSION_KEY, TIP, txidOf, W } from "./records.js";

type Of<T extends LedgerEvent["t"]> = Extract<LedgerEvent, { t: T }>;

export function depositEvent(over: Partial<Of<"deposit">> = {}): Of<"deposit"> {
  return {
    t: "deposit",
    txid: txidOf(1),
    sessionKey: SESSION_KEY,
    valueZat: W.toString(),
    zeroConf: true,
    expiryHeight: TIP + 40,
    firstSeenTip: TIP,
    status: "pending",
    minedHeight: null,
    confirmations: 0,
    ...over,
  };
}

export function voucherEvent(over: Partial<Of<"voucher">> = {}): Of<"voucher"> {
  return { t: "voucher", sessionKey: SESSION_KEY, cumulativeZat: "5000", ...over };
}

export function statusEvent(over: Partial<Of<"status">> = {}): Of<"status"> {
  return {
    t: "status",
    txid: txidOf(1),
    status: "confirmed",
    minedHeight: TIP + 1,
    confirmations: 1,
    deadAtTip: null,
    ...over,
  };
}
