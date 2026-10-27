import type { Ledger, LedgerEvent } from "./ledger.js";
import { DEAD_RECHECK_BLOCKS, type DepositRecord } from "./types.js";

type Of<T extends LedgerEvent["t"]> = Extract<LedgerEvent, { t: T }>;

/** Sessions and deposits rebuilt from ledger events, the only way they change */
export class FacilitatorState {
  readonly #sessions = new Map<string, { sessionKey: string; cLast: bigint }>();
  readonly #deposits = new Map<string, DepositRecord>();
  readonly #txidsBySession = new Map<string, string[]>();

  /** Throws when the event breaks an invariant, before changing anything */
  apply(e: LedgerEvent): void {
    switch (e.t) {
      case "deposit":
        return this.#credit(e);
      case "voucher":
        return this.#settle(e);
      case "status":
        return this.#move(e);
    }
  }

  session(key: string): { sessionKey: string; cLast: bigint } | undefined {
    const session = this.#sessions.get(key);
    return session === undefined ? undefined : { ...session };
  }

  depositsOf(key: string): DepositRecord[] {
    const deposits: DepositRecord[] = [];
    for (const txid of this.#txidsBySession.get(key) ?? []) {
      const deposit = this.#deposits.get(txid);
      if (deposit !== undefined) deposits.push(deposit);
    }
    return deposits;
  }

  deposit(txid: string): DepositRecord | undefined {
    return this.#deposits.get(txid);
  }

  ownerOf(txid: string): string | undefined {
    return this.#deposits.get(txid)?.sessionKey;
  }

  liveDeposits(tip: number): DepositRecord[] {
    return [...this.#deposits.values()].filter((d) => isLive(d, tip));
  }

  #credit(e: Of<"deposit">): void {
    if (this.#deposits.has(e.txid)) throw new Error(`deposit ${e.txid} is already credited`);
    const record: DepositRecord = {
      txid: e.txid,
      sessionKey: e.sessionKey,
      valueZat: BigInt(e.valueZat),
      zeroConf: e.zeroConf,
      expiryHeight: e.expiryHeight,
      firstSeenTip: e.firstSeenTip,
      status: e.status,
      minedHeight: e.minedHeight,
      confirmations: e.confirmations,
      notFound: null,
      deadAtTip: null,
    };
    this.#deposits.set(e.txid, Object.freeze(record));
    const txids = this.#txidsBySession.get(e.sessionKey);
    if (txids === undefined) this.#txidsBySession.set(e.sessionKey, [e.txid]);
    else txids.push(e.txid);
  }

  #settle(e: Of<"voucher">): void {
    const cumulative = BigInt(e.cumulativeZat);
    const settled = this.#sessions.get(e.sessionKey)?.cLast ?? 0n;
    if (cumulative < settled) throw new Error(`voucher ${cumulative} is below the settled cumulative ${settled}`);
    this.#sessions.set(e.sessionKey, { sessionKey: e.sessionKey, cLast: cumulative });
  }

  #move(e: Of<"status">): void {
    const record = this.#deposits.get(e.txid);
    if (record === undefined) throw new Error(`status for unknown deposit ${e.txid}`);
    const moved: DepositRecord = {
      ...record,
      status: e.status,
      minedHeight: e.minedHeight,
      confirmations: e.confirmations,
      deadAtTip: e.deadAtTip,
      notFound: null,
    };
    this.#deposits.set(e.txid, Object.freeze(moved));
  }
}

function isLive(deposit: DepositRecord, tip: number): boolean {
  if (deposit.status === "dead") {
    return deposit.deadAtTip !== null && tip - deposit.deadAtTip <= DEAD_RECHECK_BLOCKS;
  }
  return deposit.status !== "final";
}

/** Synchronous on purpose, so a settle can check and commit with no await between */
export function commit(ledger: Ledger, state: FacilitatorState, events: LedgerEvent[]): void {
  ledger.appendSync(events);
  for (const e of events) state.apply(e);
}
