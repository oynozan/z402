import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs";
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

/** A batch refused before a byte of it was written, which leaves the ledger as good as it was */
export class LedgerRefusal extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LedgerRefusal";
  }
}

/** Append-only JSON Lines log (in memory without a path), unsynced, so appends outlive a crash but not a power loss */
export class Ledger {
  readonly #path: string | undefined;
  readonly #memory: LedgerEvent[] = [];
  /** The failed write after which every append is refused, since the file and the live state may disagree */
  #broken: { cause: unknown } | undefined;

  constructor(path?: string) {
    this.#path = path;
    if (path !== undefined) mkdirSync(dirname(path), { recursive: true });
  }

  /** Writes the batch in one call or not at all, and refuses every batch once a write has failed */
  appendSync(events: LedgerEvent[]): void {
    if (this.#broken !== undefined) {
      throw new Error("the ledger refuses writes after a failed write; restart the facilitator to replay it", {
        cause: this.#broken.cause,
      });
    }
    const bad = events.findIndex((e) => !isEvent(e));
    if (bad >= 0) throw new LedgerRefusal(`${nth(events[bad], bad)} is not a ledger event`);
    if (events.length === 0) return;
    if (this.#path === undefined) {
      this.#memory.push(...structuredClone(events));
      return;
    }
    const before = sizeOf(this.#path);
    try {
      appendFileSync(this.#path, events.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    } catch (e) {
      this.#broken = { cause: e };
      // A write that failed part-way may have left a prefix, which the next start would read as a bad line
      try {
        truncateSync(this.#path, before);
      } catch {}
      throw e;
    }
  }

  /** Must run before the first append to an existing file, since it cuts a torn last line an append would glue onto */
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

function isMissing(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (e) {
    if (isMissing(e)) return 0;
    throw e;
  }
}

const KINDS: ReadonlySet<unknown> = new Set(["deposit", "voucher", "status"]);

/** "event N" of a batch, with its type when it is one the ledger knows, and never a value from the event */
export function nth(e: unknown, index: number): string {
  const t = typeof e === "object" && e !== null ? (e as { t?: unknown }).t : undefined;
  return KINDS.has(t) ? `event ${index + 1} (${String(t)})` : `event ${index + 1}`;
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
