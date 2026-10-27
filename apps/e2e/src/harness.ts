/**
 * The whole z402 stack in one process (protocol.md §15): a FakeChain, the facilitator reading it, the paid API in
 * front of the facilitator, and the stock x402 fetch paying through PrepaidVoucherScheme with a MockWallet.
 * Every stack gets its own chain and an in-memory facilitator ledger, since FakeChain txids repeat across instances.
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

/** Starts the facilitator, then the API on it, then the paying client, and closes what started if a later step fails */
export async function startStack(o: StackOptions): Promise<Stack> {
  const { priceZat } = o;
  const chain = new FakeChain({ expiryDelta: EXPIRY_DELTA });
  const facilitator = await startFacilitator({
    network: NETWORK,
    chain: chain.viewFor(PAY_TO),
    payTo: PAY_TO,
    priceZat,
    terms: DEMO_TERMS,
    pollIntervalMs: 50,
    port: 0,
  });

  let api: ApiHandle | undefined;
  try {
    api = await startApi({ network: NETWORK, facilitatorUrl: facilitator.url, payTo: PAY_TO, priceZat, port: 0 });
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
    return stack({ chain, wallet, paidFetch, scheme, facilitator, api });
  } catch (e) {
    // The failure that stopped the start is the one worth reporting, not a close that fails after it
    await api?.close().catch(() => undefined);
    await facilitator.close().catch(() => undefined);
    throw e;
  }
}

function stack(parts: Omit<Stack, "close">): Stack {
  const { scheme, api, facilitator } = parts;
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    try {
      await scheme.close();
    } finally {
      try {
        await api.close();
      } finally {
        await facilitator.close();
      }
    }
  };
  return { ...parts, close: () => (closing ??= close()) };
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
