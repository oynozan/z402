/**
 * The paying client, built the way the demo agent builds its own (apps/agent/src/zcash.ts and agent.ts): the
 * prepaid-voucher scheme over a Zallet wallet and a chain status read from lightwalletd, registered on the stock x402
 * client for one network, and the stock fetch wrapper over it. The client keeps one session, and makes one deposit, for
 * each merchant it pays, so the services that share a merchant share them.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { LightwalletdTxStatus, PrepaidVoucherScheme, ZalletRpcWallet, type PrepaidVoucherSchemeOptions } from "@z402/client";
import { createLightwalletdClient } from "@z402/lightwalletd";
import type { TxStatusSource, ZcashWallet } from "@z402/protocol";
import type { Flags } from "./flags.js";
import { formatEvent } from "./log.js";

/** The deposit window of the demo terms, which is unknown before the first 402 */
const ASSUMED_WINDOW_ZAT = 100_000n;
/** The most Zallet has been seen to charge for one deposit */
const DEPOSIT_FEE_ZAT = 25_000n;
/** One deposit pays for a whole run, which is a few thousand zat of calls */
export const PREFLIGHT_FLOOR_ZAT = ASSUMED_WINDOW_ZAT + DEPOSIT_FEE_ZAT;

export class PreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PreflightError";
  }
}

/**
 * Reads the wallet before the first call. A wallet that cannot be read, or that cannot fund the deposit, would
 * otherwise show up as a failed payment on every paid step, each after a wait for the deposit to be retried.
 */
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
      `the wallet has ${balance} zat spendable, a run needs at least ${PREFLIGHT_FLOOR_ZAT} zat ` +
        `(one deposit of ${ASSUMED_WINDOW_ZAT} zat plus up to ${DEPOSIT_FEE_ZAT} zat of fee)`,
    );
  }
  return balance;
}

export interface SessionLine {
  payTo: string;
  /** Everything vouchered to this merchant, which counts a call that failed after its voucher */
  cumulativeZat: bigint;
}

export interface Payer {
  paidFetch: typeof fetch;
  /** Zat vouchered so far, over all the merchants paid */
  spent(): bigint;
  sessions(): SessionLine[];
  /** Lets a deposit in flight finish, then closes the wallet and the chain client. Safe to call twice. */
  close(): Promise<void>;
}

type Wallet = ZcashWallet & { spendableBalance(): Promise<bigint> };

/** What createPayer builds from the flags by default, for a test to replace */
export interface PayerDeps {
  wallet?: Wallet;
  chain?: { status: TxStatusSource; close(): void };
  scheme?: Partial<PrepaidVoucherSchemeOptions>;
}

function lightwalletd(url: string): { status: TxStatusSource; close(): void } {
  const lwd = createLightwalletdClient({ url });
  return { status: new LightwalletdTxStatus(lwd), close: () => lwd.close() };
}

export async function createPayer(flags: Flags, warn: (line: string) => void, deps: PayerDeps = {}): Promise<Payer> {
  const wallet: Wallet =
    deps.wallet ?? new ZalletRpcWallet({ url: flags.zalletUrl, user: flags.zalletUser, password: flags.zalletPassword });
  const chain = deps.chain ?? lightwalletd(flags.lightwalletd);
  try {
    warn(`wallet: ${await preflight(wallet)} zat spendable`);
  } catch (e) {
    await wallet.close?.().catch(() => undefined);
    chain.close();
    throw e;
  }

  const merchants = new Set<string>();
  // The total of a voucher that is out and has no answer yet. The client counts a call only when its answer comes, or
  // after two minutes, so a call that is cut short has been paid for as far as anyone can tell and still looks free.
  let unanswered: bigint | undefined;
  const scheme = new PrepaidVoucherScheme({
    wallet,
    chain: chain.status,
    onEvent: (e) => {
      if (e.type === "session") merchants.add(e.payTo);
      else if (e.type === "voucher") unanswered = BigInt(e.cumulativeZat);
      else if (e.type === "paid" || e.type === "refused" || e.type === "ambiguous") unanswered = undefined;
      const line = formatEvent(e);
      if (line !== undefined) warn(line);
    },
    ...deps.scheme,
  });
  // Registered for this one network, so an offer on any other is not paid
  const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register(flags.network, scheme));

  const sessions = (): SessionLine[] => {
    const lines = [...merchants].flatMap((payTo) => {
      const session = scheme.session(payTo, flags.network);
      return session === undefined ? [] : [{ payTo, cumulativeZat: session.cumulativeZat }];
    });
    // A voucher event does not name its merchant, so a voucher still out is counted only when there is one
    const [only] = lines;
    if (lines.length !== 1 || only === undefined || unanswered === undefined) return lines;
    return [{ ...only, cumulativeZat: only.cumulativeZat > unanswered ? only.cumulativeZat : unanswered }];
  };
  let closed: Promise<void> | undefined;
  return {
    paidFetch,
    spent: () => sessions().reduce((sum, s) => sum + s.cumulativeZat, 0n),
    sessions,
    close: () => (closed ??= scheme.close().finally(() => chain.close())),
  };
}
