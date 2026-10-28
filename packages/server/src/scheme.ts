/** The x402 server scheme for prepaid-voucher, registered in the API's x402ResourceServer */
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import {
  ASSET,
  isValidPayTo,
  isZcashNetwork,
  parseTerms,
  SCHEME,
  ZCASH_NETWORKS,
  ZEC_DECIMALS,
  type ZcashNetwork,
} from "@z402/protocol";

/** The facilitator-owned fields of an `accepts` entry's `extra` (protocol.md section 2) */
export const TERM_KEYS = [
  "windowZat",
  "creditRatioBps",
  "creditCapZat",
  "zeroConfMinExpiryBlocks",
  "termsVersion",
] as const;

const PRICE_AMOUNT_RE = /^[1-9][0-9]*$/;
const TERMS_VERSION_RE = /^[0-9a-f]{16}$/;

export class PrepaidVoucherServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;

  readonly #network: ZcashNetwork;
  /** Session snapshot of a refused verify, keyed by the request's PaymentPayload object */
  readonly #refusedSessions = new WeakMap<object, unknown>();

  constructor(o: { payTo: string; network: string }) {
    if (!isZcashNetwork(o.network)) {
      throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
    }
    if (!isValidPayTo(o.payTo, o.network)) {
      throw new Error(`payTo: not a shielded-only unified address for ${o.network}`);
    }
    this.#network = o.network;
  }

  // Core may call these detached from this object, so they are arrow functions
  readonly schemeHooks: SchemeServerHooks = {
    onAfterVerify: async (ctx) => {
      if (!ctx.result.isValid) this.#refusedSessions.set(ctx.paymentPayload, ctx.result.extra?.session);
    },
  };

  // Kept after use, since core calls this once per accept with the same per-request payload, and the entry dies with it
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<void> => {
    if (ctx.paymentPayload === undefined) return;
    const session = this.#refusedSessions.get(ctx.paymentPayload);
    if (session === undefined) return;
    for (const accept of ctx.requirements) {
      if (accept.scheme !== this.scheme || accept.network !== this.#network) continue;
      accept.extra = { ...accept.extra, session };
    }
  };

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (
      typeof price === "object" &&
      price !== null &&
      price.asset === ASSET &&
      typeof price.amount === "string" &&
      PRICE_AMOUNT_RE.test(price.amount)
    ) {
      // No extra, the terms come from the facilitator in enhancePaymentRequirements
      return { amount: price.amount, asset: ASSET };
    }
    const form = `{ amount: "<zatoshi, no leading zero>", asset: "${ASSET}" }`;
    throw new Error(`${SCHEME} on ${network} takes a price of ${form}`);
  }

  getAssetDecimals(asset: string, _network: Network): number | undefined {
    return asset === ASSET ? ZEC_DECIMALS : undefined;
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    // Terms only, a facilitator that still advertises a payTo of its own has it ignored
    const terms: Record<string, unknown> = {};
    for (const key of TERM_KEYS) {
      const value = supportedKind.extra?.[key];
      if (value !== undefined) terms[key] = value;
    }
    return { ...paymentRequirements, extra: { ...paymentRequirements.extra, ...terms } };
  }

  validateFacilitatorSupport(
    _network: Network,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): string | void {
    const extra = supportedKind.extra ?? {};
    try {
      parseTerms(extra);
    } catch (e) {
      return `facilitator terms are invalid (${e instanceof Error ? e.message : String(e)})`;
    }
    const version = extra.termsVersion;
    if (typeof version !== "string" || !TERMS_VERSION_RE.test(version)) {
      return "facilitator extra.termsVersion must be 16 lowercase hex characters";
    }
  }
}
