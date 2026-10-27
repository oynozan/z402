import { PrepaidVoucherScheme, ZalletRpcWallet } from "@z402/client";
import { zainoTxStatus } from "./chain.js";
import { FlagError, type Flags } from "./flags.js";
import { formatEvent, formatZat } from "./log.js";

/** The window is unknown before the first 402, so the preflight assumes the demo's 100,000 zat */
const ASSUMED_WINDOW_ZAT = 100_000n;
/** The most Zallet has been seen to charge for one deposit */
const DEPOSIT_FEE_ZAT = 25_000n;
/** Two deposits, so the second can fund the run once the first is spent */
export const PREFLIGHT_FLOOR_ZAT = 2n * (ASSUMED_WINDOW_ZAT + DEPOSIT_FEE_ZAT);

export class PreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PreflightError";
  }
}

export async function preflight(wallet: { spendableBalance(): Promise<bigint> }): Promise<bigint> {
  let balance: bigint;
  try {
    balance = await wallet.spendableBalance();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new PreflightError(`cannot read the spendable balance of the wallet: ${reason}`, { cause });
  }
  if (balance < PREFLIGHT_FLOOR_ZAT) {
    throw new PreflightError(
      `the wallet has ${formatZat(balance)} zat spendable, the demo needs at least ${formatZat(PREFLIGHT_FLOOR_ZAT)} zat ` +
        `(two deposits of ${formatZat(ASSUMED_WINDOW_ZAT)} zat plus up to ${formatZat(DEPOSIT_FEE_ZAT)} zat of fee each)`,
    );
  }
  return balance;
}

export interface ZcashClient {
  zcashClientScheme: PrepaidVoucherScheme;
  /** Lets deposits in flight finish, then closes the wallet and the chain client */
  close(): Promise<void>;
}

export async function createZcashClient(flags: Flags, print: (line: string) => void): Promise<ZcashClient> {
  if (flags.wallet !== "zallet") throw new FlagError("zingo-cli wallet arrives in Phase 2 (mainnet)");

  const wallet = new ZalletRpcWallet({ url: flags.zalletUrl, user: flags.zalletUser, password: flags.zalletPassword });
  const chain = zainoTxStatus(flags.lightwalletd);
  try {
    const balance = await preflight(wallet);
    print(`wallet: ${formatZat(balance)} zat spendable`);
  } catch (e) {
    chain.close();
    throw e;
  }

  const zcashClientScheme = new PrepaidVoucherScheme({
    wallet,
    chain: chain.status,
    ...(flags.cheat ? { maxDeposits: 1 } : {}),
    onEvent: (e) => {
      const line = formatEvent(e);
      if (line !== undefined) print(line);
    },
  });
  let closed: Promise<void> | undefined;
  return {
    zcashClientScheme,
    close: () =>
      (closed ??= zcashClientScheme.close().finally(() => {
        chain.close();
      })),
  };
}
