import type { ClientEvent } from "@z402/client";
import { clean } from "./http.js";

/** First 4 and last 2 characters, 3f2a…c1 */
export function shortHex(hex: string): string {
  return hex.length <= 8 ? hex : `${hex.slice(0, 4)}…${hex.slice(-2)}`;
}

/** Enough of an address to tell merchants apart: the first 12 and the last 6 characters */
export function shortAddress(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 12)}…${address.slice(-6)}`;
}

const PREFIX = "  * ";

/** The lines the payment client reports while it works (a deposit can take a minute), undefined where the step line says it */
export function formatEvent(e: ClientEvent): string | undefined {
  const text = eventText(e);
  return text === undefined ? undefined : `${PREFIX}${text}`;
}

function eventText(e: ClientEvent): string | undefined {
  switch (e.type) {
    case "session":
      return `session ${shortHex(e.sessionKey)} on ${e.network}`;
    case "deposit_started":
      return `deposit D${e.index} started, ${e.inline ? "paid inline" : "in the background"}`;
    case "deposit_broadcast":
      return `deposit D${e.index} broadcast ${shortHex(e.txid)} in ${Math.round(e.ms)} ms`;
    case "deposit_failed":
      return `deposit D${e.index} failed: ${clean(e.error.message).trim()}`;
    case "deposit_acked":
      return `deposit ${shortHex(e.txid)} acknowledged by the merchant`;
    case "deposit_confirmed": {
      const name = e.index === undefined ? shortHex(e.txid) : `D${e.index} ${shortHex(e.txid)}`;
      return `deposit ${name} confirmed${e.height === undefined ? "" : ` at height ${e.height}`}`;
    }
    case "deposit_dead":
      return `deposit ${shortHex(e.txid)} DEAD, it will not count`;
    case "waiting":
      return `waiting for deposit ${shortHex(e.txid)} to confirm`;
    case "ambiguous":
      return `outcome unknown, voucher of ${e.attemptedZat} zat may or may not have been accepted`;
    case "fatal":
      return `FATAL ${clean(e.code).trim()}: ${clean(e.message).trim()}`;
    case "refused":
      // A refusal the client gives up on comes back as the call's own 402, which its step line shows
      return e.recovering ? `refused ${clean(e.code).trim()}, recovering` : undefined;
    case "voucher":
    case "paid":
      return undefined;
  }
}
