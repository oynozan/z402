/**
 * The whole z402 stack in one process (protocol.md §15): a FakeChain, the facilitator reading it, the paid API in
 * front of the facilitator, and the stock x402 fetch paying through PrepaidVoucherScheme with a MockWallet.
 * Every stack gets its own chain and an in-memory facilitator ledger, since FakeChain txids repeat across instances.
 * startMerchants puts several merchants, each with its own facilitator and API, on one chain and one paying client.
 */
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
  x402HTTPClient,
  type PaymentRequired,
} from "@x402/fetch";
import { startApi, type ApiHandle } from "@z402/api";
import { PrepaidVoucherScheme, type ClientEvent } from "@z402/client";
import { startFacilitator, type FacilitatorHandle } from "@z402/facilitator";
import { DEMO_TERMS, NETWORK_REGTEST, parseSessionSnapshot, type SessionSnapshot } from "@z402/protocol";
import { FakeChain, MockWallet } from "@z402/testkit";

export const NETWORK = NETWORK_REGTEST;
export const PAY_TO = `uregtest1${"q".repeat(60)}`;
export const PAY_TO_2 = `uregtest1${"p".repeat(60)}`;
/** Zallet's expiry delta under NU6.3 */
export const EXPIRY_DELTA = 40;
/** Covers a close that waits up to about 5 s for the API's keep-alive connection to the facilitator to idle out */
export const CLOSE_TIMEOUT_MS = 15_000;

export interface StackOptions {
  priceZat: bigint;
  maxDeposits?: number;
  /** The scheme's event stream, for tests that check what the client did */
  onEvent?: (e: ClientEvent) => void;
}

export interface Stack {
  chain: FakeChain;
  wallet: MockWallet;
  paidFetch: typeof fetch;
  scheme: PrepaidVoucherScheme;
  facilitator: FacilitatorHandle;
  api: ApiHandle;
  /** Closes the scheme, then the API, then the facilitator, each even when the one before it fails */
  close(): Promise<void>;
}

export interface Merchant {
  payTo: string;
  priceZat: bigint;
  facilitator: FacilitatorHandle;
  api: ApiHandle;
}

export interface MultiStackOptions {
  merchants: readonly { payTo: string; priceZat: bigint }[];
  onEvent?: (e: ClientEvent) => void;
}

export interface MultiStack {
  chain: FakeChain;
  wallet: MockWallet;
  paidFetch: typeof fetch;
  scheme: PrepaidVoucherScheme;
  merchants: Merchant[];
  /** Closes the scheme, then each merchant's API and facilitator, each even when one before it fails */
  close(): Promise<void>;
}

/** Starts the facilitator, then the API on it, then the paying client, and closes what started if a later step fails */
export async function startStack(o: StackOptions): Promise<Stack> {
  const { merchants, close, ...rest } = await startOn(new FakeChain({ expiryDelta: EXPIRY_DELTA }), [{ payTo: PAY_TO, priceZat: o.priceZat }], o);
  const { facilitator, api } = merchants[0]!;
  return { ...rest, facilitator, api, close };
}

/** Every merchant on one chain, each with its own facilitator and API, and one client paying all of them */
export function startMerchants(o: MultiStackOptions): Promise<MultiStack> {
  return startOn(new FakeChain({ expiryDelta: EXPIRY_DELTA }), o.merchants, o);
}

async function startOn(
  chain: FakeChain,
  specs: MultiStackOptions["merchants"],
  o: { maxDeposits?: number; onEvent?: (e: ClientEvent) => void },
): Promise<MultiStack> {
  const merchants: Merchant[] = [];
  try {
    for (const spec of specs) merchants.push(await startMerchant(chain, spec.payTo, spec.priceZat));
    const wallet = new MockWallet(chain);
    const scheme = new PrepaidVoucherScheme({
      wallet,
      chain: chain.statusSource(),
      pollIntervalMs: 20,
      facilitatorLagMs: 100,
      ...(o.maxDeposits !== undefined && { maxDeposits: o.maxDeposits }),
      ...(o.onEvent !== undefined && { onEvent: o.onEvent }),
    });
    const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register(NETWORK, scheme));
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => (closing ??= scheme.close().finally(() => closeAll(merchants)));
    return { chain, wallet, paidFetch, scheme, merchants, close };
  } catch (e) {
    // The failure that stopped the start is the one worth reporting, not a close that fails after it
    await closeAll(merchants).catch(() => undefined);
    throw e;
  }
}

async function startMerchant(chain: FakeChain, payTo: string, priceZat: bigint): Promise<Merchant> {
  const facilitator = await startFacilitator({
    network: NETWORK,
    chain: chain.viewFor(payTo),
    payTo,
    priceZat,
    terms: DEMO_TERMS,
    pollIntervalMs: 50,
    port: 0,
  });
  try {
    const api = await startApi({ network: NETWORK, facilitatorUrl: facilitator.url, payTo, priceZat, port: 0 });
    return { payTo, priceZat, facilitator, api };
  } catch (e) {
    await facilitator.close().catch(() => undefined);
    throw e;
  }
}

/** Each merchant's API then its facilitator, every one of them even when one fails, and the first failure after */
async function closeAll(merchants: readonly Merchant[]): Promise<void> {
  const results = await Promise.allSettled(merchants.map((m) => m.api.close().finally(() => m.facilitator.close())));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

/** The decoded PAYMENT-RESPONSE of a paid call */
export function paymentResponse(res: Response): ReturnType<typeof decodePaymentResponseHeader> {
  const header = res.headers.get("payment-response");
  if (header === null) throw new Error(`a ${res.status} response without PAYMENT-RESPONSE`);
  return decodePaymentResponseHeader(header);
}

/** The session snapshot a successful settle carried in its PAYMENT-RESPONSE */
export function paidSnapshot(res: Response): SessionSnapshot {
  const settle = paymentResponse(res);
  if (settle.success !== true) throw new Error(`PAYMENT-RESPONSE is a failed settle (${settle.errorReason})`);
  const snapshot = parseSessionSnapshot((settle.extra as { session?: unknown } | undefined)?.session);
  if (snapshot === null) throw new Error("PAYMENT-RESPONSE carries no valid extra.session");
  return snapshot;
}

/** The decoded PAYMENT-REQUIRED of a 402, after reading its body so the connection is freed */
export async function paymentRequired(res: Response): Promise<PaymentRequired> {
  if (res.status !== 402) throw new Error(`expected a 402, got ${res.status}`);
  await res.text();
  const header = res.headers.get("payment-required");
  if (header === null) throw new Error("a 402 without PAYMENT-REQUIRED");
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => res.headers.get(name));
}

/** The snapshot a corrective 402 carried in its first `accepts` entry, or null when it has none */
export function refusalSnapshot(required: PaymentRequired): SessionSnapshot | null {
  return parseSessionSnapshot(required.accepts[0]?.extra?.session);
}
