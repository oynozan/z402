import type { ChainView, TxInspection } from "@z402/protocol";
import type { LedgerEvent } from "./ledger.js";
import type { FacilitatorState } from "./state.js";
import { observe } from "./transitions.js";
import type { DepositRecord } from "./types.js";

type Streak = NonNullable<DepositRecord["notFound"]>;

/** Keeps the status of every live deposit current by re-reading the chain on each new tip and at least every sweep */
export class ChainWatcher {
  readonly #chain: ChainView;
  readonly #state: FacilitatorState;
  readonly #commit: (events: LedgerEvent[]) => void;
  readonly #intervalMs: number;
  readonly #sweepMs: number;
  readonly #refreshMinMs: number;
  readonly #now: () => number;
  readonly #log: (msg: string, err?: unknown) => void;
  // The state never holds a not-found streak, so the watcher counts them from pass to pass
  readonly #streaks = new Map<string, Streak>();
  readonly #refreshedAt = new Map<string, number>();
  #sweep: { tip: number; at: number } | null = null;
  #lastTip: number | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #turn: Promise<void> = Promise.resolve();

  constructor(o: {
    chain: ChainView;
    state: FacilitatorState;
    commit: (events: LedgerEvent[]) => void;
    intervalMs?: number;
    sweepMs?: number;
    refreshMinMs?: number;
    now?: () => number;
    log?: (msg: string, err?: unknown) => void;
  }) {
    this.#chain = o.chain;
    this.#state = o.state;
    this.#commit = o.commit;
    this.#intervalMs = o.intervalMs ?? 5000;
    this.#sweepMs = o.sweepMs ?? 30_000;
    this.#refreshMinMs = o.refreshMinMs ?? 5000;
    this.#now = o.now ?? (() => Date.now());
    this.#log = o.log ?? ((msg, err) => console.warn(msg, err));
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs).unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The newest tip any read has seen, or null before the first one */
  lastTip(): number | null {
    return this.#lastTip;
  }

  /** Re-reads every live deposit now, and logs instead of throwing when the chain cannot answer */
  pollNow(): Promise<void> {
    return this.#pass(undefined);
  }

  /** Re-reads one session's live deposits, or returns false at once if it was refreshed less than refreshMinMs ago */
  async refreshSession(sessionKey: string): Promise<boolean> {
    const now = this.#now();
    const last = this.#refreshedAt.get(sessionKey);
    if (last !== undefined && now - last < this.#refreshMinMs) return false;

    this.#stamp(sessionKey, now);
    await this.#pass(sessionKey);
    return true;
  }

  async #tick(): Promise<void> {
    try {
      const tip = await this.#chain.tip();
      this.#lastTip = tip;
      const sweep = this.#sweep;
      if (sweep === null || tip !== sweep.tip || this.#now() - sweep.at >= this.#sweepMs) await this.pollNow();
    } catch (e) {
      this.#log("chain tick failed", e);
    }
  }

  #pass(sessionKey: string | undefined): Promise<void> {
    return this.#alone(async () => {
      try {
        const tip = await this.#chain.tip();
        this.#lastTip = tip;
        // A refresh of one session leaves the tip change for the full pass to handle
        if (sessionKey === undefined) this.#sweep = { tip, at: this.#now() };
        const live = this.#state.liveDeposits(tip);
        await this.#reread(sessionKey === undefined ? live : live.filter((d) => d.sessionKey === sessionKey), tip);
      } catch (e) {
        this.#log(sessionKey === undefined ? "chain poll failed" : "session refresh failed", e);
      }
    });
  }

  /** Runs passes one at a time, so an older answer never lands on top of a newer one */
  #alone(job: () => Promise<void>): Promise<void> {
    const run = this.#turn.then(job);
    this.#turn = run.catch(() => undefined);
    return run;
  }

  async #reread(deposits: DepositRecord[], tip: number): Promise<void> {
    const events: LedgerEvent[] = [];
    for (const before of deposits) {
      const after = await this.#look(before, tip);
      if (after !== undefined && moved(before, after)) events.push(statusOf(after));
    }
    if (events.length > 0) this.#commit(events);
  }

  /** The deposit after one more look at the chain, or undefined when the chain gave no answer */
  async #look(before: DepositRecord, tip: number): Promise<DepositRecord | undefined> {
    let answer: TxInspection;
    try {
      answer = await this.#chain.inspect(before.txid);
    } catch (e) {
      this.#log(`inspect of ${before.txid} failed`, e);
      return undefined;
    }
    const after = observe({ ...before, notFound: this.#streaks.get(before.txid) ?? null }, answer, tip, this.#now());
    if (after.notFound === null) this.#streaks.delete(before.txid);
    else this.#streaks.set(before.txid, after.notFound);
    return after;
  }

  #stamp(sessionKey: string, now: number): void {
    // Stamps sit in the order they were made, so the ones past the throttle are at the front
    for (const [key, at] of this.#refreshedAt) {
      if (now - at < this.#refreshMinMs) break;
      this.#refreshedAt.delete(key);
    }
    this.#refreshedAt.delete(sessionKey);
    this.#refreshedAt.set(sessionKey, now);
  }
}

function moved(before: DepositRecord, after: DepositRecord): boolean {
  return (
    before.status !== after.status ||
    before.minedHeight !== after.minedHeight ||
    before.confirmations !== after.confirmations ||
    before.deadAtTip !== after.deadAtTip
  );
}

function statusOf(d: DepositRecord): LedgerEvent {
  return {
    t: "status",
    txid: d.txid,
    status: d.status,
    minedHeight: d.minedHeight,
    confirmations: d.confirmations,
    deadAtTip: d.deadAtTip,
  };
}
