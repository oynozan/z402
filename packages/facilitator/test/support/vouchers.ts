import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { publicKeyFromSeed, signVoucher } from "@z402-net/protocol";

/** The protocol test-vector seed 000102…1f (packages/protocol/test/vectors.json) */
export const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
export const SESSION_KEY = publicKeyFromSeed(SEED);

/** A second agent, for deposits and vouchers of another session */
export const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
export const OTHER_SESSION_KEY = publicKeyFromSeed(OTHER_SEED);

/** `PaymentPayload.payload` of a voucher signed over the requirements' scheme, network and payTo */
export function voucherFor(
  requirements: Pick<PaymentRequirements, "scheme" | "network" | "payTo">,
  cumulativeZat: bigint,
  o: { seed?: Uint8Array; depositTxid?: string } = {},
): Record<string, unknown> {
  const seed = o.seed ?? SEED;
  const sessionKey = publicKeyFromSeed(seed);
  const cumulative = cumulativeZat.toString();
  const sig = signVoucher(seed, {
    scheme: requirements.scheme,
    network: requirements.network,
    payTo: requirements.payTo,
    sessionKey,
    cumulativeZat: cumulative,
  });
  return {
    sessionKey,
    cumulativeZat: cumulative,
    sig,
    ...(o.depositTxid === undefined ? {} : { depositTxid: o.depositTxid }),
  };
}

/** The x402 v2 envelope a stock client sends, echoing the requirements it accepted */
export function paymentFor(requirements: PaymentRequirements, payload: Record<string, unknown>): PaymentPayload {
  return { x402Version: 2, accepted: requirements, payload };
}
