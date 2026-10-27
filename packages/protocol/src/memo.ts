import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";
import { SESSION_KEY_RE } from "./validate.js";

const MEMO_RE = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,8})$/;
const MAX_INDEX = 999_999_999;

/** The ZIP 302 text memo of a deposit, `"<sessionKey>:<index>"` (protocol.md §5.1). */
export function depositMemo(sessionKey: string, index: number): string {
  if (typeof sessionKey !== "string" || !SESSION_KEY_RE.test(sessionKey)) {
    throw new ProtocolError(REASON.invalidPayload, "sessionKey is not 64 lowercase hex");
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new ProtocolError(REASON.invalidPayload, "deposit index is not an integer in 0..999999999");
  }
  return `${sessionKey}:${index}`;
}

/** Strict: no trimming. The caller strips trailing zero bytes from the raw memo field first. */
export function parseDepositMemo(memo: string): { sessionKey: string; index: number } | null {
  if (typeof memo !== "string") return null;
  const m = MEMO_RE.exec(memo);
  if (!m) return null;
  return { sessionKey: m[1] as string, index: Number(m[2]) };
}
