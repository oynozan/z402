import { createHash } from "node:crypto";
import {
  ChainUnavailableError,
  type ChainView,
  type FoundInspection,
  type TxInspection,
  type TxStatus,
  type TxStatusSource,
} from "@z402/protocol";

export interface FakeTxOutput {
  to: string;
  valueZat: bigint;
  memo: string | null;
}

export interface FakeTx {
  outputs: FakeTxOutput[];
  hasTransparent?: boolean;
  /** Blocks after the next block that the tx stays valid. 0 means `expiryHeight = 0`, which never expires. */
  expiryDelta?: number;
}

type Location = FoundInspection["location"];

interface StoredTx {
  outputs: FakeTxOutput[];
  hasTransparent: boolean;
  expiryHeight: number;
  location: Location;
  minedHeight: number | null;
  held: boolean;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * In-memory stand-in for Zebra and lightwalletd. Writes (`broadcast`, `mine`, `reorg`, ...) always work;
 * only the reads behind `viewFor` and `statusSource` fail under `setUnavailable`.
 *
 * Txids are deterministic per instance and repeat across instances (the Nth broadcast of every fresh
 * `FakeChain` has the same txid), so never share a facilitator ledger across two `FakeChain`s.
 */
export class FakeChain {
  readonly #defaultExpiryDelta: number;
  readonly #txs = new Map<string, StoredTx>();
  #height: number;
  #counter = 0;
  #unavailable = false;

  constructor(o: { startHeight?: number; expiryDelta?: number } = {}) {
    this.#height = o.startHeight ?? 1000;
    this.#defaultExpiryDelta = o.expiryDelta ?? 120;
    assertCount("startHeight", this.#height);
    assertCount("expiryDelta", this.#defaultExpiryDelta);
  }

  get height(): number {
    return this.#height;
  }

  broadcast(tx: FakeTx): string {
    const delta = tx.expiryDelta ?? this.#defaultExpiryDelta;
    assertCount("expiryDelta", delta);
    this.#counter += 1;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(this.#counter));
    const txid = createHash("sha256").update(counter).digest("hex");
    this.#txs.set(txid, {
      outputs: tx.outputs.map((o) => ({ to: o.to, valueZat: o.valueZat, memo: o.memo })),
      hasTransparent: tx.hasTransparent ?? false,
      expiryHeight: delta === 0 ? 0 : this.#height + 1 + delta,
      location: "mempool",
      minedHeight: null,
      held: false,
    });
    return txid;
  }

  /** Each block takes every live, un-held mempool tx, then evicts unmined txs (held ones too) whose expiry the tip reached. */
  mine(n = 1): void {
    assertCount("n", n);
    for (let i = 0; i < n; i++) {
      this.#height += 1;
      for (const tx of this.#txs.values()) {
        if (tx.location !== "mempool" || tx.held) continue;
        if (tx.expiryHeight === 0 || tx.expiryHeight >= this.#height) {
          tx.location = "mined";
          tx.minedHeight = this.#height;
        }
      }
      this.#evictExpired();
    }
  }

  hold(txid: string): void {
    const tx = this.#get(txid);
    if (tx.location !== "mempool") throw new Error(`cannot hold ${txid}: it is not in the mempool`);
    tx.held = true;
  }

  /** Releases a held tx so the next `mine` includes it, provided it has not expired (an expired one is already gone). */
  unhold(txid: string): void {
    const tx = this.#get(txid);
    if (!tx.held) throw new Error(`cannot unhold ${txid}: it is not held`);
    tx.held = false;
  }

  /** Evicts a mempool tx at once. An unknown txid is a no-op; a mined tx throws. */
  drop(txid: string): void {
    const tx = this.#txs.get(txid);
    if (tx === undefined) return;
    if (tx.location === "mined") throw new Error(`cannot drop ${txid}: it is mined`);
    this.#txs.delete(txid);
  }

  /** Zebra keeps the orphaned blocks' txs visible on the fork, so they read as `orphaned` rather than vanishing. */
  reorg(depth: number): void {
    assertCount("depth", depth);
    if (depth > this.#height) throw new RangeError(`cannot reorg ${depth} blocks from height ${this.#height}`);
    this.#height -= depth;
    for (const tx of this.#txs.values()) {
      if (tx.location === "mined" && tx.minedHeight !== null && tx.minedHeight > this.#height) {
        this.#orphan(tx);
      }
    }
  }

  orphan(txid: string): void {
    const tx = this.#get(txid);
    if (tx.location !== "mined") throw new Error(`cannot orphan ${txid}: it is not mined`);
    this.#orphan(tx);
  }

  /** Returns an orphaned tx to the mempool, unless the tip already reached its expiry, which evicts it at once. */
  rebroadcast(txid: string): void {
    const tx = this.#get(txid);
    if (tx.location !== "orphaned") throw new Error(`cannot rebroadcast ${txid}: it is not orphaned`);
    tx.location = "mempool";
    this.#evictExpired();
  }

  setUnavailable(on: boolean): void {
    this.#unavailable = on;
  }

  viewFor(payTo: string): ChainView {
    return {
      tip: async () => this.#read(() => this.#height),
      inspect: async (txid) => this.#read((): TxInspection => {
        const tx = this.#txs.get(txid);
        if (tx === undefined) return { found: false };
        return {
          found: true,
          txid,
          location: tx.location,
          minedHeight: tx.minedHeight,
          expiryHeight: tx.expiryHeight,
          hasTransparent: tx.hasTransparent,
          outputs: tx.outputs
            .filter((o) => o.to === payTo)
            .map((o) => ({ pool: "ironwood" as const, valueZat: o.valueZat, memo: o.memo })),
        };
      }),
    };
  }

  statusSource(): TxStatusSource {
    return {
      tip: async () => this.#read(() => this.#height),
      status: async (txid) => this.#read((): TxStatus => {
        const tx = this.#txs.get(txid);
        if (tx === undefined) return { found: false };
        return {
          found: true,
          location: tx.location,
          minedHeight: tx.minedHeight,
          expiryHeight: tx.expiryHeight,
        };
      }),
    };
  }

  #read<T>(fn: () => T): T {
    if (this.#unavailable) throw new ChainUnavailableError("FakeChain is unavailable");
    return fn();
  }

  #get(txid: string): StoredTx {
    const tx = this.#txs.get(txid);
    if (tx === undefined) throw new Error(`unknown txid ${txid}`);
    return tx;
  }

  #evictExpired(): void {
    for (const [txid, tx] of this.#txs) {
      if (tx.location === "mempool" && tx.expiryHeight !== 0 && this.#height >= tx.expiryHeight) {
        this.#txs.delete(txid);
      }
    }
  }

  #orphan(tx: StoredTx): void {
    tx.location = "orphaned";
    tx.minedHeight = null;
  }
}
