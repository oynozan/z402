/**
 * LightwalletdTxStatus, the client's TxStatusSource over a lightwalletd-like client (design §5). The input is
 * typed structurally, so the client never depends on `@z402-net/lightwalletd` or on gRPC.
 */
import { ChainUnavailableError, expiryHeightFromRawTx, type TxStatus, type TxStatusSource } from "@z402-net/protocol";

/** `RawTx` of protocol.md §15, where `height` is set only when `location` is `mined` */
export type RawTx =
  | { found: false }
  | { found: true; raw: Uint8Array; location: "mempool" | "mined" | "orphaned"; height: number | null };

export interface LightwalletdLike {
  getTip(): Promise<number>;
  getTransaction(txid: string): Promise<RawTx>;
}

/** Keeps the outage class the source promises, whatever the client threw */
function unavailable(what: string, cause: unknown): ChainUnavailableError {
  if (cause instanceof ChainUnavailableError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ChainUnavailableError(`${what}: ${detail}`, { cause });
}

export class LightwalletdTxStatus implements TxStatusSource {
  readonly #lwd: LightwalletdLike;

  constructor(lwd: LightwalletdLike) {
    this.#lwd = lwd;
  }

  async tip(): Promise<number> {
    try {
      return await this.#lwd.getTip();
    } catch (e) {
      throw unavailable("lightwalletd tip", e);
    }
  }

  async status(txid: string): Promise<TxStatus> {
    try {
      const tx = await this.#lwd.getTransaction(txid);
      if (!tx.found) return { found: false };
      return {
        found: true,
        location: tx.location,
        minedHeight: tx.location === "mined" ? tx.height : null,
        expiryHeight: expiryHeightFromRawTx(tx.raw),
      };
    } catch (e) {
      // A raw transaction we cannot read must never look like a definitive answer about the deposit
      throw unavailable(`lightwalletd transaction ${txid}`, e);
    }
  }
}
