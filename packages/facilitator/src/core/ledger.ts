import { appendFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { DEPOSIT_STATUSES, MAX_MONEY_ZAT, ZAT_RE, type DepositStatus } from "@z402/protocol";

export type LedgerEvent =
  | {
      t: "deposit";
      txid: string;
      sessionKey: string;
      valueZat: string;
      zeroConf: boolean;
      expiryHeight: number;
      firstSeenTip: number;
      status: DepositStatus;
      minedHeight: number | null;
      confirmations: number;
    }
  | { t: "voucher"; sessionKey: string; cumulativeZat: string }
  | {
      t: "status";
      txid: string;
      status: DepositStatus;
      minedHeight: number | null;
      confirmations: number;
      deadAtTip: number | null;
    };

/** Append-only JSON Lines log, or an in-memory log when built without a path */
export class Ledger {
  readonly #path: string | undefined;
  readonly #memory: LedgerEvent[] = [];

  constructor(path?: string) {
    this.#path = path;
    if (path !== undefined) mkdirSync(dirname(path), { recursive: true });
  }

  /** Writes the batch in one call, or throws without writing when an event is not one replay accepts */
  appendSync(events: LedgerEvent[]): void {
    const bad = events.findIndex((e) => !isEvent(e));
    if (bad >= 0) throw new Error(`event ${bad + 1} is not a ledger event`);
    if (events.length === 0) return;
    if (this.#path === undefined) {
      this.#memory.push(...structuredClone(events));
      return;
    }
    appendFileSync(this.#path, events.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  }

  replay(): LedgerEvent[] {
    if (this.#path === undefined) return structuredClone(this.#memory);
    const text = readText(this.#path);
    if (text === null) return [];

    const lines = text.split("\n");
    const last = lines.findLastIndex((l) => l.trim() !== "");
    const events: LedgerEvent[] = [];
    for (let i = 0; i <= last; i++) {
      const raw = lines[i] ?? "";
      if (raw.trim() === "") continue;

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        if (i < last) throw new Error(`ledger line ${i + 1} is not valid JSON`);
        this.#dropTail(this.#path, lines, i);
        return events;
      }
      if (!isEvent(value)) throw new Error(`ledger line ${i + 1} is not a ledger event`);
      events.push(value);
    }
    if (last >= 0 && !text.endsWith("\n")) appendFileSync(this.#path, "\n");
    return events;
  }

  // Cut the torn bytes off, or the next append would glue onto them
  #dropTail(path: string, lines: string[], index: number): void {
    console.warn(`ledger ${path}: dropped a truncated last line (line ${index + 1})`);
    const kept = lines.slice(0, index).map((l) => `${l}\n`).join("");
    truncateSync(path, Buffer.byteLength(kept));
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

const isId = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const isZat = (v: unknown): boolean => typeof v === "string" && ZAT_RE.test(v) && BigInt(v) <= MAX_MONEY_ZAT;
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isHeight = (v: unknown): boolean => v === null || isCount(v);
const isStatus = (v: unknown): boolean => typeof v === "string" && (DEPOSIT_STATUSES as readonly string[]).includes(v);

/** The shape check of replay, shared with the writers so that no line is written that replay would refuse */
export function isEvent(x: unknown): x is LedgerEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  switch (e.t) {
    case "deposit":
      return (
        isId(e.txid) &&
        isId(e.sessionKey) &&
        isZat(e.valueZat) &&
        typeof e.zeroConf === "boolean" &&
        isCount(e.expiryHeight) &&
        isCount(e.firstSeenTip) &&
        isStatus(e.status) &&
        isHeight(e.minedHeight) &&
        isCount(e.confirmations)
      );
    case "voucher":
      return isId(e.sessionKey) && isZat(e.cumulativeZat);
    case "status":
      return (
        isId(e.txid) &&
        isStatus(e.status) &&
        isHeight(e.minedHeight) &&
        isCount(e.confirmations) &&
        isHeight(e.deadAtTip)
      );
    default:
      return false;
  }
}
