import { MAX_MONEY_ZAT } from "./constants.js";
import { DEPOSIT_STATUSES, type DepositStatus } from "./ramp.js";
import { SESSION_KEY_RE, TXID_RE, ZAT_RE } from "./validate.js";

export interface SnapshotDeposit {
  txid: string;
  valueZat: string;
  status: DepositStatus;
  confirmations: number;
  expiryHeight: number;
  zeroConf: boolean;
}

/** `extra.session` of protocol.md section 7.2. All amounts are canonical zat decimal strings. */
export interface SessionSnapshot {
  sessionKey: string;
  cumulativeZat: string;
  limitZat: string;
  headroomZat: string;
  confirmedZat: string;
  pendingZat: string;
  creditZat: string;
  tip: number;
  deposits: SnapshotDeposit[];
}

type Fields = Record<string, unknown>;

function asFields(x: unknown): Fields | null {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Fields) : null;
}

function own(o: Fields, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function zatString(v: unknown): string | null {
  return typeof v === "string" && ZAT_RE.test(v) && BigInt(v) <= MAX_MONEY_ZAT ? v : null;
}

function patternString(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function isStatus(v: unknown): v is DepositStatus {
  return typeof v === "string" && (DEPOSIT_STATUSES as readonly string[]).includes(v);
}

function parseDeposit(x: unknown): SnapshotDeposit | null {
  const o = asFields(x);
  if (o === null) return null;

  const txid = patternString(own(o, "txid"), TXID_RE);
  const valueZat = zatString(own(o, "valueZat"));
  const status = own(o, "status");
  const confirmations = count(own(o, "confirmations"));
  const expiryHeight = count(own(o, "expiryHeight"));
  const zeroConf = own(o, "zeroConf");
  if (
    txid === null ||
    valueZat === null ||
    !isStatus(status) ||
    confirmations === null ||
    expiryHeight === null ||
    typeof zeroConf !== "boolean"
  ) {
    return null;
  }
  return { txid, valueZat, status, confirmations, expiryHeight, zeroConf };
}

function parse(x: unknown): SessionSnapshot | null {
  const o = asFields(x);
  if (o === null) return null;

  const sessionKey = patternString(own(o, "sessionKey"), SESSION_KEY_RE);
  const cumulativeZat = zatString(own(o, "cumulativeZat"));
  const limitZat = zatString(own(o, "limitZat"));
  const headroomZat = zatString(own(o, "headroomZat"));
  const confirmedZat = zatString(own(o, "confirmedZat"));
  const pendingZat = zatString(own(o, "pendingZat"));
  const creditZat = zatString(own(o, "creditZat"));
  const tip = count(own(o, "tip"));
  const rawDeposits = own(o, "deposits");
  if (
    sessionKey === null ||
    cumulativeZat === null ||
    limitZat === null ||
    headroomZat === null ||
    confirmedZat === null ||
    pendingZat === null ||
    creditZat === null ||
    tip === null ||
    !Array.isArray(rawDeposits)
  ) {
    return null;
  }

  const deposits: SnapshotDeposit[] = [];
  for (let i = 0; i < rawDeposits.length; i++) {
    const deposit = parseDeposit(rawDeposits[i]);
    if (deposit === null) return null;
    deposits.push(deposit);
  }
  return { sessionKey, cumulativeZat, limitZat, headroomZat, confirmedZat, pendingZat, creditZat, tip, deposits };
}

/** Returns a validated copy with unknown keys dropped, or `null`. Never throws. */
export function parseSessionSnapshot(x: unknown): SessionSnapshot | null {
  try {
    return parse(x);
  } catch {
    // A hostile proxy or getter can throw from any property access.
    return null;
  }
}
