import { ChainUnavailableError, type ChainView, type FoundInspection } from "@z402/protocol";

export type Lookup =
  | { kind: "found"; inspection: FoundInspection; tip: number }
  | { kind: "not_found" }
  | { kind: "unavailable"; error: unknown };

/** Looks deposits up on the chain within a time budget, sharing and limiting the work */
export class DepositResolver {
  readonly #chain: ChainView;
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #pollMs: number;
  readonly #negativeTtlMs: number;
  readonly #resultTtlMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (msg: string, err?: unknown) => void;
  readonly #flights = new Map<string, Promise<Lookup>>();
  readonly #results = new Map<string, { lookup: Lookup; at: number }>();
  readonly #queue: Array<() => void> = [];
  #running = 0;

  constructor(o: {
    chain: ChainView;
    maxConcurrent?: number;
    /** Callers that may wait for a slot, past which a lookup is answered unavailable at once */
    maxQueued?: number;
    pollMs?: number;
    negativeTtlMs?: number;
    resultTtlMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (msg: string, err?: unknown) => void;
  }) {
    this.#chain = o.chain;
    this.#maxConcurrent = o.maxConcurrent ?? 4;
    this.#maxQueued = o.maxQueued ?? 16;
    this.#pollMs = o.pollMs ?? 1000;
    this.#negativeTtlMs = o.negativeTtlMs ?? 10_000;
    // Settle credits from peek(), and an older found result says nothing of whether the deposit is still in the mempool
    this.#resultTtlMs = o.resultTtlMs ?? 30_000;
    this.#now = o.now ?? (() => Date.now());
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = o.log ?? ((msg, err) => console.error(msg, err));
  }

  /** Settles within the longest budget in use plus one inspect and one tip, and joins a flight already under way */
  lookup(txid: string, budgetMs: number): Promise<Lookup> {
    const running = this.#flights.get(txid);
    if (running !== undefined) return running;

    const flight = this.#fly(txid, this.#recentlyMissed(txid) ? 0 : budgetMs).finally(() => {
      this.#flights.delete(txid);
    });
    this.#flights.set(txid, flight);
    return flight;
  }

  /** Runs a lookup nobody waits for, so `peek` can answer once it resolves */
  startBackground(txid: string, budgetMs: number): void {
    // A failure has no caller to go to, so it is logged, and the next lookup runs afresh
    this.lookup(txid, budgetMs).catch((e: unknown) => {
      if (e instanceof ChainUnavailableError) return;
      try {
        this.#log("background deposit lookup failed", e);
      } catch {}
    });
  }

  /** The latest result for the txid, until it expires or is forgotten */
  peek(txid: string): Lookup | undefined {
    const held = this.#results.get(txid);
    if (held === undefined) return undefined;
    if (this.#now() - held.at >= this.#resultTtlMs) {
      this.#results.delete(txid);
      return undefined;
    }
    return held.lookup;
  }

  /** True while a lookup for the txid is running or queued, however it was started */
  inFlight(txid: string): boolean {
    return this.#flights.has(txid);
  }

  forget(txid: string): void {
    this.#results.delete(txid);
  }

  async #fly(txid: string, budgetMs: number): Promise<Lookup> {
    const startedAt = this.#now();
    if (this.#running >= this.#maxConcurrent && this.#queue.length >= this.#maxQueued) {
      return { kind: "unavailable", error: new ChainUnavailableError("deposit lookups are saturated") };
    }
    let outage: ChainUnavailableError | undefined;
    let reads = 0;
    for (;;) {
      // A slot is held only around a read, so lookups sleeping between polls leave it to the others
      const waited = await this.#acquire();
      try {
        // A caller whose budget ran out in the queue gets what is known, not one more read past its budget
        if (waited && this.#now() - startedAt >= budgetMs) {
          if (reads > 0) break;
          const error = new ChainUnavailableError("deposit lookup waited its whole budget for a slot");
          return this.peek(txid) ?? { kind: "unavailable", error };
        }
        reads++;
        const found = await this.#read(txid);
        if (found !== undefined) {
          this.#remember(txid, found);
          return found;
        }
      } catch (e) {
        if (!(e instanceof ChainUnavailableError)) throw e;
        outage = e;
      } finally {
        this.#release();
      }
      // Written as a negation so a NaN budget ends the loop instead of running it forever
      if (!(this.#now() - startedAt + this.#pollMs <= budgetMs)) break;
      await this.#sleep(this.#pollMs);
    }
    const lookup: Lookup = outage === undefined ? { kind: "not_found" } : { kind: "unavailable", error: outage };
    this.#remember(txid, lookup);
    return lookup;
  }

  /** One inspect, and the tip once the deposit is found, undefined while the chain shows nothing */
  async #read(txid: string): Promise<Lookup | undefined> {
    const inspection = await this.#chain.inspect(txid);
    return inspection.found ? { kind: "found", inspection, tip: await this.#chain.tip() } : undefined;
  }

  #recentlyMissed(txid: string): boolean {
    const last = this.#results.get(txid);
    return last?.lookup.kind === "not_found" && this.#now() - last.at < this.#negativeTtlMs;
  }

  #remember(txid: string, lookup: Lookup): void {
    const at = this.#now();
    // Results sit in the order they were stored, so the expired ones are at the front
    for (const [key, held] of this.#results) {
      if (at - held.at < this.#resultTtlMs) break;
      this.#results.delete(key);
    }
    this.#results.delete(txid);
    this.#results.set(txid, { lookup, at });
  }

  /** Takes a slot, true when the caller had to wait in the queue for it */
  async #acquire(): Promise<boolean> {
    if (this.#running < this.#maxConcurrent) {
      this.#running++;
      return false;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    return true;
  }

  #release(): void {
    const next = this.#queue.shift();
    // The slot passes straight to the next in line, so the running count stays put
    if (next === undefined) this.#running--;
    else next();
  }
}
