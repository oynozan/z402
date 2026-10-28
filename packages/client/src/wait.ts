import {
  ChainUnavailableError,
  isDepositDead,
  NOT_FOUND_DEAD_BLOCKS,
  NOT_FOUND_DEAD_MS,
  type TxStatus,
  type TxStatusSource,
} from "@z402-net/protocol";
import type { Clock } from "./clock.js";

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  clock: Clock;
}

/** One definitive reading of a tx, where seen means unmined in the mempool or orphaned */
export type Observation = { kind: "mined"; height: number } | { kind: "seen" } | { kind: "dead" };

export type WatchResult = Observation | { kind: "timeout" };

/** Follows one txid across status reads and applies the dead rules of protocol.md §5.3 */
export class TxWatch {
  readonly #chain: TxStatusSource;
  readonly #txid: string;
  readonly #clock: Clock;
  #expiryHeight: number | undefined;
  #streak: { since: number; tip: number } | undefined;

  constructor(chain: TxStatusSource, txid: string, clock: Clock) {
    this.#chain = chain;
    this.#txid = txid;
    this.#clock = clock;
  }

  /** Undefined while the tx is unseen but alive, or when the chain gave no definitive answer */
  async observe(): Promise<Observation | undefined> {
    let status: TxStatus;
    let tip: number;
    try {
      status = await this.#chain.status(this.#txid);
      if (status.found) {
        this.#streak = undefined;
        if (status.location === "mined" && status.minedHeight !== null) {
          return { kind: "mined", height: status.minedHeight };
        }
      }
      tip = await this.#chain.tip();
    } catch (e) {
      // A transport error is no answer, so the not-found streak neither counts nor resets
      if (e instanceof ChainUnavailableError) return undefined;
      throw e;
    }

    if (status.found) {
      if (status.location === "mined") return { kind: "mined", height: status.minedHeight ?? tip };
      this.#expiryHeight = status.expiryHeight;
      const dead = isDepositDead({ minedHeight: null, expiryHeight: status.expiryHeight, tip });
      return dead ? { kind: "dead" } : { kind: "seen" };
    }

    // The node evicts an unmined tx at its expiry, so not-found past a seen expiry is dead
    const expiryHeight = this.#expiryHeight;
    if (expiryHeight !== undefined && isDepositDead({ minedHeight: null, expiryHeight, tip })) return { kind: "dead" };
    const now = this.#clock.now();
    this.#streak ??= { since: now, tip };
    const dead = now - this.#streak.since >= NOT_FOUND_DEAD_MS && tip - this.#streak.tip >= NOT_FOUND_DEAD_BLOCKS;
    return dead ? { kind: "dead" } : undefined;
  }
}

/** Polls until the tx is mined (or just seen), dead or timed out, with the last poll on the deadline */
export async function watchTx(
  chain: TxStatusSource,
  txid: string,
  o: WaitOptions & { until: "mined" | "seen" },
): Promise<WatchResult> {
  if (!(o.pollMs > 0)) throw new RangeError(`pollMs must be positive, got ${o.pollMs}`);
  const watch = new TxWatch(chain, txid, o.clock);
  const deadline = o.clock.now() + o.timeoutMs;
  for (;;) {
    const seen = await watch.observe();
    if (seen !== undefined && (seen.kind !== "seen" || o.until === "seen")) return seen;
    const left = deadline - o.clock.now();
    if (left <= 0) return { kind: "timeout" };
    await o.clock.sleep(Math.min(o.pollMs, left));
  }
}

/** Waits for `txid` to be mined (design §3.4), retrying `ChainUnavailableError` until the timeout */
export async function waitForConfirmation(
  chain: TxStatusSource,
  txid: string,
  o: WaitOptions,
): Promise<"mined" | "dead" | "timeout"> {
  const result = await watchTx(chain, txid, { ...o, until: "mined" });
  // Polling for mined keeps going on a seen tx, so seen never comes back here
  return result.kind === "seen" ? "timeout" : result.kind;
}
