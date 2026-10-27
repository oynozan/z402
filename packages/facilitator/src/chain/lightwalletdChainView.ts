import type { LightwalletdClient, RawTx } from "@z402/lightwalletd";
import {
  ChainUnavailableError,
  TXID_RE,
  type ChainView,
  type TxInspection,
  type ZcashNetwork,
} from "@z402/protocol";
import {
  ZdecryptError,
  zdecryptDecrypt,
  zdecryptNetwork,
  type ZdecryptAt,
  type ZdecryptNetwork,
  type ZReport,
} from "./zdecrypt.js";

type Lightwalletd = Pick<LightwalletdClient, "getTip" | "getTransaction">;
type FoundTx = Extract<RawTx, { found: true }>;

/** Reads deposits from lightwalletd and trial-decrypts them with the merchant key through zdecrypt */
export class LightwalletdChainView implements ChainView {
  readonly #lwd: Lightwalletd;
  readonly #zdecryptBin: string;
  readonly #uivk: string;
  readonly #payTo: string;
  readonly #network: ZdecryptNetwork;

  /** `uivk` may also be a UFVK, which additionally sees the wallet's own change as internal outputs */
  constructor(o: { lwd: Lightwalletd; zdecryptBin: string; uivk: string; payTo: string; network: ZcashNetwork }) {
    this.#lwd = o.lwd;
    this.#zdecryptBin = o.zdecryptBin;
    this.#uivk = o.uivk;
    this.#payTo = o.payTo;
    this.#network = zdecryptNetwork(o.network);
  }

  tip(): Promise<number> {
    return this.#lwd.getTip();
  }

  async inspect(txid: string): Promise<TxInspection> {
    if (!TXID_RE.test(txid)) throw new TypeError("txid must be 64 lowercase hex characters");
    const tx = await this.#lwd.getTransaction(txid);
    if (!tx.found) return { found: false };

    const report = await this.#decrypt(txid, tx);
    if (report.txid !== txid) {
      throw new ChainUnavailableError(`lightwalletd returned transaction ${report.txid}, which does not match ${txid}`);
    }
    return {
      found: true,
      txid,
      location: tx.location,
      minedHeight: tx.location === "mined" ? tx.height : null,
      expiryHeight: report.expiryHeight,
      hasTransparent: report.transparentIn + report.transparentOut > 0,
      outputs: report.outputs
        .filter((out) => out.scope === "external" && out.toPayTo === true)
        .map((out) => ({
          pool: out.pool,
          valueZat: BigInt(out.valueZat),
          memo: out.memoKind === "text" ? out.memoText : null,
        })),
    };
  }

  async #at(txid: string, tx: FoundTx): Promise<ZdecryptAt> {
    if (tx.location !== "mined") return { tip: await this.#lwd.getTip() };
    if (tx.height === null) {
      throw new ChainUnavailableError(`lightwalletd reported transaction ${txid} as mined without a block height`);
    }
    return { height: tx.height };
  }

  // Bytes zdecrypt cannot read give no answer about the deposit, so they count as an outage
  async #decrypt(txid: string, tx: FoundTx): Promise<ZReport> {
    const at = await this.#at(txid, tx);
    try {
      return await zdecryptDecrypt({
        bin: this.#zdecryptBin,
        key: this.#uivk,
        rawHex: Buffer.from(tx.raw).toString("hex"),
        at,
        payTo: this.#payTo,
        network: this.#network,
      });
    } catch (e) {
      if (e instanceof ZdecryptError) {
        throw new ChainUnavailableError(`zdecrypt could not read transaction ${txid}: ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
}
