import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";
import { parseZat, SESSION_KEY_RE, SIG_RE, TXID_RE } from "./validate.js";

/** `PaymentPayload.payload` of a prepaid-voucher payment (protocol.md §3). */
export interface VoucherPayload {
  sessionKey: string;
  cumulativeZat: string;
  sig: string;
  depositTxid?: string;
}

function invalid(message: string): ProtocolError {
  return new ProtocolError(REASON.invalidPayload, message);
}

function hexField(fields: Record<string, unknown>, name: string, re: RegExp): string {
  const value = fields[name];
  if (typeof value !== "string" || !re.test(value)) throw invalid(`${name} is malformed`);
  return value;
}

/** Canonical or rejected: nothing is normalized, and `cumulativeZat` comes back as the received string. */
export function parseVoucherPayload(p: unknown): VoucherPayload {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw invalid("payload is not an object");
  const fields = p as Record<string, unknown>;

  const sessionKey = hexField(fields, "sessionKey", SESSION_KEY_RE);
  const cumulativeZat = fields.cumulativeZat;
  parseZat(cumulativeZat as string);
  const sig = hexField(fields, "sig", SIG_RE);

  const out: VoucherPayload = { sessionKey, cumulativeZat: cumulativeZat as string, sig };
  if (fields.depositTxid !== undefined) out.depositTxid = hexField(fields, "depositTxid", TXID_RE);
  return out;
}
