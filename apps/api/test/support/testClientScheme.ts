/**
 * A minimal prepaid-voucher client scheme for the stock x402 client, standing in for @z402/client in these tests.
 * It signs `synced + price` on every call, attaches the pending deposit until a successful settle acknowledges it
 * (protocol.md v1.1 section 7.3), and resyncs once from a corrective 402 on z402_cumulative_mismatch.
 */
import type { PaymentResponseContext } from "@x402/core/client";
import type {
  DefaultAsset,
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  ASSET,
  generateSeed,
  parseSessionSnapshot,
  publicKeyFromSeed,
  REASON,
  SCHEME,
  signVoucher,
  ZEC_DECIMALS,
  type SessionSnapshot,
} from "@z402/protocol";

/** A successful settle as the client saw it */
export interface Settled {
  transaction: string;
  session: SessionSnapshot;
}

export class TestClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly sessionKey: string;
  /** The cumulative of the last settled voucher, the base of the next one */
  synced = 0n;
  /** Sent with every voucher until a successful settle acknowledges it */
  pendingTxid: string | undefined;
  readonly settled: Settled[] = [];
  readonly acked: string[] = [];
  /** Reason codes of the refusals this client saw, in order */
  readonly refusals: string[] = [];
  readonly #seed: Uint8Array;

  constructor(seed: Uint8Array = generateSeed()) {
    this.#seed = seed;
    this.sessionKey = publicKeyFromSeed(seed);
  }

  // Without it the stock client's spend controls refuse every ZEC requirement
  findDefaultAsset = (asset: string, network: Network): DefaultAsset | undefined =>
    asset === ASSET && network.startsWith("zcash:")
      ? { asset: ASSET, decimals: ZEC_DECIMALS, symbol: ASSET }
      : undefined;

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const cumulativeZat = (this.synced + BigInt(req.amount)).toString();
    const sig = signVoucher(this.#seed, {
      scheme: req.scheme,
      network: req.network,
      payTo: req.payTo,
      sessionKey: this.sessionKey,
      cumulativeZat,
    });
    const deposit = this.pendingTxid === undefined ? {} : { depositTxid: this.pendingTxid };
    return { x402Version, payload: { sessionKey: this.sessionKey, cumulativeZat, sig, ...deposit } };
  }

  readonly schemeHooks: SchemeClientHooks = {
    onPaymentResponse: async (ctx) => this.#onResponse(ctx),
  };

  #onResponse(ctx: PaymentResponseContext): { recovered: true } | undefined {
    const settle = ctx.settleResponse;
    if (settle?.success === true) {
      const session = parseSessionSnapshot(settle.extra?.session);
      if (session === null) throw new Error("a successful settle carried no valid session snapshot");
      this.synced = BigInt(session.cumulativeZat);
      this.settled.push({ transaction: settle.transaction, session });
      const txid = this.pendingTxid;
      if (txid !== undefined && (settle.transaction === txid || session.deposits.some((d) => d.txid === txid))) {
        this.acked.push(txid);
        this.pendingTxid = undefined;
      }
      return undefined;
    }

    const reason = settle?.errorReason ?? ctx.paymentRequired?.error;
    if (reason !== undefined) this.refusals.push(reason);
    // A refusal's snapshot is projected, so it may resync the counter but never acknowledges a deposit
    if (ctx.paymentRequired?.error === REASON.cumulativeMismatch) {
      const session = parseSessionSnapshot(ctx.paymentRequired.accepts[0]?.extra?.session);
      if (session !== null) {
        this.synced = BigInt(session.cumulativeZat);
        return { recovered: true };
      }
    }
    return undefined;
  }
}
