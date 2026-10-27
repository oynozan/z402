export interface DepositRequest {
  to: string;
  amountZat: bigint;
  memo: string;
}

export interface ZcashWallet {
  sendDeposit(req: DepositRequest): Promise<{ txid: string }>;
  close?(): Promise<void>;
}

export type TxStatus =
  | { found: false }
  | {
      found: true;
      location: "mempool" | "mined" | "orphaned";
      minedHeight: number | null;
      expiryHeight: number;
    };

export interface TxStatusSource {
  tip(): Promise<number>;
  /** Throws `ChainUnavailableError` on transport errors. */
  status(txid: string): Promise<TxStatus>;
}
