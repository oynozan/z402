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

/** A tip read this recently is reused, so an inspect and the read right after it cost one GetLatestBlock */
const TIP_REUSE_MS = 1000;
/** Block heights are u32 in the transaction format and in zdecrypt's arguments */
const MAX_HEIGHT = 0xffff_ffff;

const isBlockHeight = (h: number): boolean => Number.isSafeInteger(h) && h >= 0 && h <= MAX_HEIGHT;

/** Reads deposits from lightwalletd and trial-decrypts them with the merchant key through zdecrypt */
export class LightwalletdChainView implements ChainView {
  readonly #lwd: Lightwalletd;
  readonly #zdecryptBin: string;
  readonly #uivk: string;
  readonly #payTo: string;
  readonly #network: ZdecryptNetwork;
  readonly #now: () => number;
  #tipRead: { value: number; at: number } | undefined;

  /** `uivk` may also be a UFVK, which additionally sees the wallet's own change as internal outputs */
  constructor(o: {
    lwd: Lightwalletd;
    zdecryptBin: string;
    uivk: string;
    payTo: string;
    network: ZcashNetwork;
    now?: () => number;
  }) {
    this.#lwd = o.lwd;
    this.#zdecryptBin = o.zdecryptBin;
    this.#uivk = o.uivk;
    this.#payTo = o.payTo;
    this.#network = zdecryptNetwork(o.network);
    this.#now = o.now ?? (() => Date.now());
  }

  async tip(): Promise<number> {
    const held = this.#tipRead;
    if (held !== undefined && this.#now() - held.at < TIP_REUSE_MS) return held.value;
    const value = await this.#lwd.getTip();
    if (!isBlockHeight(value)) {
      throw new ChainUnavailableError(`lightwalletd reported tip ${value}, which is not a block height`);
    }
    this.#tipRead = { value, at: this.#now() };
    return value;
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
    if (tx.location !== "mined") return { tip: await this.tip() };
    if (tx.height === null) {
      throw new ChainUnavailableError(`lightwalletd reported transaction ${txid} as mined without a block height`);
    }
    if (!isBlockHeight(tx.height)) {
      throw new ChainUnavailableError(
        `lightwalletd reported transaction ${txid} as mined at ${tx.height}, which is not a block height`,
      );
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
