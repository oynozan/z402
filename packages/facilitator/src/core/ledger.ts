import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEPOSIT_STATUSES,
  isZcashNetwork,
  MAX_MONEY_ZAT,
  NETWORK_MAINNET,
  ZAT_RE,
  type DepositStatus,
  type ZcashNetwork,
} from "@z402/protocol";

export type LedgerEvent =
  /** The first line of a ledger, naming the facilitator that created it */
  | { t: "ledger"; network: ZcashNetwork; payTo: string }
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

/** The facilitator a ledger belongs to */
export interface LedgerOwner {
  network: ZcashNetwork;
  payTo: string;
}

/** A ledger that belongs to another facilitator, refused before replay reads past its first line */
export class LedgerMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerMismatch";
  }
}

/** Refuses the ledger whose first event, undefined when it has none, shows it is not the ledger of `own` */
export function checkLedgerHeader(first: LedgerEvent | undefined, own: LedgerOwner, path: string): void {
  if (first === undefined) return;
  if (first.t === "ledger") {
    if (first.network === own.network && first.payTo === own.payTo) return;
    throw new LedgerMismatch(
      `ledgerPath: ${path} is the ledger of ${first.network} ${first.payTo}, not of this facilitator`,
    );
  }
  // A ledger from before the header existed opens off mainnet, where a mixup moves no real money
  if (own.network === NETWORK_MAINNET) {
    throw new LedgerMismatch(
      `ledgerPath: ${path} has no ledger header; a mainnet facilitator opens only a ledger it created`,
    );
  }
}

/** Append-only JSON Lines log (in memory without a path), unsynced, so appends outlive a crash but not a power loss */
export class Ledger {
  readonly #path: string | undefined;
  readonly #chunkBytes: number;
  readonly #guard: (() => void) | undefined;
  readonly #memory: LedgerEvent[] = [];
  /** The failed write after which every append is refused, since the file and the live state may disagree */
  #broken: { cause: unknown } | undefined;

  constructor(
    path?: string,
    o: {
      /** How much replay reads at a time, for tests */
      chunkBytes?: number;
      /** Runs before every write to the file, and a throw from it refuses that write and every one after */
      guard?: () => void;
    } = {},
  ) {
    this.#path = path;
    this.#chunkBytes = o.chunkBytes ?? CHUNK_BYTES;
    this.#guard = o.guard;
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
    try {
      this.#guard?.();
    } catch (e) {
      this.#broken = { cause: e };
      throw e;
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
    return [...this.events()];
  }

  /** The events one at a time, read in chunks so that neither the file nor its events are ever held whole */
  *events(): Generator<LedgerEvent> {
    if (this.#path === undefined) {
      yield* structuredClone(this.#memory);
      return;
    }
    const path = this.#path;
    const fd = openIfThere(path);
    if (fd === undefined) return;
    let torn: { number: number; start: number } | undefined;
    let any = false;
    let ended = true;
    try {
      for (const line of linesOf(fd, this.#chunkBytes)) {
        ended = line.ended;
        if (line.text !== undefined && line.text.trim() === "") continue;
        // A bad line that anything but blank lines follows is damage, not a write cut short
        if (torn !== undefined) throw new Error(`ledger line ${torn.number} is not valid JSON`);
        any = true;
        const value = parsed(line.text);
        if (value === NOT_JSON) {
          torn = { number: line.number, start: line.start };
          continue;
        }
        if (!isEvent(value)) throw new Error(`ledger line ${line.number} is not a ledger event`);
        yield value;
      }
    } finally {
      closeSync(fd);
    }
    if (torn !== undefined) this.#dropTail(path, torn);
    else if (any && !ended) appendFileSync(path, "\n");
  }

  // Cut the torn bytes off, or the next append would glue onto them
  #dropTail(path: string, torn: { number: number; start: number }): void {
    console.warn(`ledger ${path}: dropped a truncated last line (line ${torn.number})`);
    truncateSync(path, torn.start);
  }
}

const CHUNK_BYTES = 64 * 1024;
/** A line longer than this is no event, so its bytes are not kept */
const MAX_LINE_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const NOT_JSON = Symbol("not JSON");

interface Line {
  /** Undefined when the line is over MAX_LINE_BYTES */
  text: string | undefined;
  number: number;
  /** The byte the line starts at, where a torn tail is cut */
  start: number;
  /** False only for a last line with no newline after it */
  ended: boolean;
}

/** Splits on the newline byte, so a multi-byte character across two chunks is decoded whole */
function* linesOf(fd: number, chunkBytes: number): Generator<Line> {
  const chunk = Buffer.alloc(chunkBytes);
  let parts: Buffer[] = [];
  let size = 0;
  let number = 0;
  let start = 0;
  let offset = 0;
  const keep = (piece: Buffer): void => {
    if (size + piece.length <= MAX_LINE_BYTES) parts.push(Buffer.from(piece));
    size += piece.length;
  };
  const text = (): string | undefined => (size > MAX_LINE_BYTES ? undefined : Buffer.concat(parts).toString("utf8"));
  for (;;) {
    const read = readSync(fd, chunk, 0, chunkBytes, offset);
    if (read === 0) break;
    let from = 0;
    for (let i = 0; i < read; i++) {
      if (chunk[i] !== NEWLINE) continue;
      keep(chunk.subarray(from, i));
      yield { text: text(), number: ++number, start, ended: true };
      parts = [];
      size = 0;
      start = offset + i + 1;
      from = i + 1;
    }
    keep(chunk.subarray(from, read));
    offset += read;
  }
  if (size > 0) yield { text: text(), number: ++number, start, ended: false };
}

function parsed(text: string | undefined): unknown {
  if (text === undefined) return NOT_JSON;
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function openIfThere(path: string): number | undefined {
  try {
    return openSync(path, "r");
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

function isMissing(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (e) {
    if (isMissing(e)) return 0;
    throw e;
  }
}

const KINDS: ReadonlySet<unknown> = new Set(["ledger", "deposit", "voucher", "status"]);

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
    case "ledger":
      return isZcashNetwork(e.network) && isId(e.payTo);
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
