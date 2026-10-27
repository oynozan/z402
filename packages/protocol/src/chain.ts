export type TxInspection =
  | { found: false }
  | {
      found: true;
      txid: string;
      location: "mempool" | "mined" | "orphaned";
      /** Set only when `location === "mined"`. */
      minedHeight: number | null;
      expiryHeight: number;
      hasTransparent: boolean;
      outputs: Array<{
        pool: "orchard" | "sapling" | "ironwood";
        valueZat: bigint;
        memo: string | null;
      }>;
    };

export type FoundInspection = Extract<TxInspection, { found: true }>;

export interface ChainView {
  tip(): Promise<number>;
  /** Throws `ChainUnavailableError` on transport errors. */
  inspect(txid: string): Promise<TxInspection>;
}
