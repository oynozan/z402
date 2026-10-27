/** Thrown by a wallet when a send failed after the tx was built, so it may still reach the chain */
export class DepositUncertainError extends Error {
  readonly txid: string;

  constructor(txid: string, options?: { message?: string; cause?: unknown }) {
    super(options?.message ?? `deposit ${txid} may or may not have been broadcast`, { cause: options?.cause });
    this.name = "DepositUncertainError";
    this.txid = txid;
  }
}

export class ZalletRpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, options?: { code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ZalletRpcError";
    this.code = options?.code;
  }
}

/** The deposit may or may not exist and no txid is known, so the caller must not pay again */
export class DepositStatusUnknownError extends ZalletRpcError {
  readonly memo: string;

  constructor(memo: string, options?: { cause?: unknown }) {
    super(`deposit status unknown for memo ${memo}`, options);
    this.name = "DepositStatusUnknownError";
    this.memo = memo;
  }
}
