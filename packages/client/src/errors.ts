/** Thrown by a wallet when a send failed after the tx was built, so it may still reach the chain */
export class DepositUncertainError extends Error {
  readonly txid: string;

  constructor(txid: string, options?: { message?: string; cause?: unknown }) {
    super(options?.message ?? `deposit ${txid} may or may not have been broadcast`, { cause: options?.cause });
    this.name = "DepositUncertainError";
    this.txid = txid;
  }
}
