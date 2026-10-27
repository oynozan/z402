import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/fetch";
import type { ClientEvent } from "@z402/client";
import { parseSessionSnapshot, REASON, type SessionSnapshot } from "@z402/protocol";

export function formatZat(zat: string | bigint): string {
  return zat.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function count(n: number): string {
  return formatZat(Math.round(n).toString());
}

/** First 4 and last 2 characters, 3f2a…c1 */
export function shortHex(hex: string): string {
  return hex.length <= 8 ? hex : `${hex.slice(0, 4)}…${hex.slice(-2)}`;
}

function callHead(i: number, status: number | string): string {
  return `#${String(i).padStart(3, "0")} ${status}`;
}

/** One line per paid call, a refusal swaps limit= for the code and the limit */
export function formatCallLine(i: number, status: number, snap?: SessionSnapshot, error?: string): string {
  const head = callHead(i, status);
  if (snap === undefined) return error === undefined ? head : `${head}  REFUSED ${error}`;
  const stats = [
    `c=${formatZat(snap.cumulativeZat)}`,
    ...(error === undefined ? [`limit=${formatZat(snap.limitZat)}`] : []),
    `conf=${formatZat(snap.confirmedZat)}`,
    `pend=${formatZat(snap.pendingZat)}`,
    `credit=${formatZat(snap.creditZat)}`,
  ];
  const lead = error === undefined ? "" : `  REFUSED ${error} at limit ${formatZat(snap.limitZat)}`;
  const deposits = snap.deposits.map((d, n) => `D${n + 1} ${shortHex(d.txid)} ${d.status}`).join(", ");
  return `${head}${lead}  ${stats.join("  ")}${deposits === "" ? "" : `  ${deposits}`}`;
}

/** The message plus its cause, since fetch failed hides ECONNREFUSED in the cause */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.message !== "") return `${error.message}: ${cause.message}`;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? `${error.message}: ${code}` : error.message;
}

export function formatCallFailure(i: number, error: unknown): string {
  return `${callHead(i, "ERROR")}  ${describe(error)}`;
}

const EVENT_PREFIX = "  * ";

/** The scheme's own lines, undefined where the call line already says it */
export function formatEvent(e: ClientEvent): string | undefined {
  const text = eventText(e);
  return text === undefined ? undefined : `${EVENT_PREFIX}${text}`;
}

function eventText(e: ClientEvent): string | undefined {
  switch (e.type) {
    case "session":
      return `session ${shortHex(e.sessionKey)} on ${e.network}`;
    case "deposit_started":
      return `deposit D${e.index} started, ${e.inline ? "paid inline" : "in the background"}`;
    case "deposit_broadcast":
      return `deposit D${e.index} broadcast ${shortHex(e.txid)} in ${count(e.ms)} ms`;
    case "deposit_failed":
      return `deposit D${e.index} failed: ${e.error.message}`;
    case "deposit_acked":
      return `deposit ${shortHex(e.txid)} acknowledged by the merchant`;
    case "deposit_confirmed": {
      const name = e.index === undefined ? shortHex(e.txid) : `D${e.index} ${shortHex(e.txid)}`;
      const at = e.height === undefined ? "" : ` at height ${count(e.height)}`;
      const credit = e.snapshot === undefined ? "" : ` (credit now ${formatZat(e.snapshot.creditZat)})`;
      return `deposit ${name} confirmed${at}${credit}`;
    }
    case "deposit_dead":
      return `deposit ${shortHex(e.txid)} DEAD, it will not count`;
    case "waiting":
      return `waiting for deposit ${shortHex(e.txid)} to confirm`;
    case "ambiguous":
      return `outcome unknown, voucher of ${formatZat(e.attemptedZat)} zat may or may not have been accepted`;
    case "fatal":
      return `FATAL ${e.code}: ${e.message}`;
    case "refused":
      // A refusal the client gives up on comes back as the call's 402 with its own REFUSED line
      return e.recovering ? `refused ${e.code}, recovering` : undefined;
    case "voucher":
    case "paid":
      return undefined;
  }
}

export interface CallOutcome {
  snapshot?: SessionSnapshot;
  error?: string;
}

/** The cheat agent cannot pay a second deposit, so this refusal ends the run */
export const stopAtDepositRefusal = (outcome: CallOutcome): boolean => outcome.error === REASON.depositRequired;

function sessionOf(extra: unknown): SessionSnapshot | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  return parseSessionSnapshot((extra as { session?: unknown }).session) ?? undefined;
}

const UNSPECIFIED = "unspecified";
const UNEXPECTED_SETTLE_ERROR = "unexpected_settle_error";

function settleOf(header: string | null): SettleResponse | undefined {
  if (header === null) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

function requiredOf(header: string | null): CallOutcome {
  if (header === null) return { error: UNSPECIFIED };
  try {
    const required = decodePaymentRequiredHeader(header);
    const snapshot = sessionOf(required.accepts[0]?.extra);
    const error = required.error === undefined || required.error === "" ? UNSPECIFIED : required.error;
    return snapshot === undefined ? { error } : { snapshot, error };
  } catch {
    return { error: UNSPECIFIED };
  }
}

/** Reads the snapshot and refusal code from the response headers, never throws */
export function outcomeOf(res: Response): CallOutcome {
  if (res.status !== 200 && res.status !== 402) return {};
  const settle = settleOf(res.headers.get("PAYMENT-RESPONSE"));
  const snapshot = settle === undefined ? undefined : sessionOf(settle.extra);
  if (res.status === 200) return snapshot === undefined ? {} : { snapshot };
  // A settle failure answers 402 with PAYMENT-RESPONSE alone, and the client reads it ahead of PAYMENT-REQUIRED
  if (settle === undefined) return requiredOf(res.headers.get("PAYMENT-REQUIRED"));
  const reason = typeof settle.errorReason === "string" && settle.errorReason !== "" ? settle.errorReason : UNEXPECTED_SETTLE_ERROR;
  return {
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(settle.success ? {} : { error: reason }),
  };
}
