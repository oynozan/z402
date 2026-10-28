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

/** A tip that is reused for a second and read once for callers that ask together, which many views can share */
export function cachedTip(
  lwd: Pick<LightwalletdClient, "getTip">,
  now: () => number = () => performance.now(),
): () => Promise<number> {
  // The default clock is monotonic, so a step of the wall clock can neither freeze the tip nor expire it early
  let held: { value: number; at: number } | undefined;
  let reading: Promise<number> | undefined;

  const read = async (): Promise<number> => {
    const value = await lwd.getTip();
    if (!isBlockHeight(value)) {
      throw new ChainUnavailableError(`lightwalletd reported tip ${value}, which is not a block height`);
    }
    held = { value, at: now() };
    return value;
  };

  return () => {
    const age = held === undefined ? Number.NaN : now() - held.at;
    // A negative or unreadable age is stale, so a clock that misbehaves can only cost an extra read
    if (held !== undefined && age >= 0 && age < TIP_REUSE_MS) return Promise.resolve(held.value);
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  };
}

/** Reads deposits from lightwalletd and trial-decrypts them with the merchant key through zdecrypt */
export class LightwalletdChainView implements ChainView {
  readonly #lwd: Lightwalletd;
  readonly #zdecryptBin: string;
  readonly #uivk: string;
  readonly #payTo: string;
  readonly #network: ZdecryptNetwork;
  readonly #tip: () => Promise<number>;

  /** `uivk` may also be a UFVK, which additionally sees the wallet's own change as internal outputs */
  constructor(o: {
    lwd: Lightwalletd;
    zdecryptBin: string;
    uivk: string;
    payTo: string;
    network: ZcashNetwork;
    now?: () => number;
    /** Where the tip comes from in place of a cache of this view's own, which lets many views share one read */
    tip?: () => Promise<number>;
  }) {
    this.#lwd = o.lwd;
    this.#zdecryptBin = o.zdecryptBin;
    this.#uivk = o.uivk;
    this.#payTo = o.payTo;
    this.#network = zdecryptNetwork(o.network);
    this.#tip = o.tip ?? cachedTip(o.lwd, o.now);
  }

  tip(): Promise<number> {
    return this.#tip();
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
