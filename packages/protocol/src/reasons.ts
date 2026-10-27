/** The closed list of protocol.md §8: 8 standard x402 codes and 11 scheme codes. */
export const REASON = {
  // standard
  invalidPayload: "invalid_payload",
  invalidPaymentRequirements: "invalid_payment_requirements",
  invalidNetwork: "invalid_network",
  invalidScheme: "invalid_scheme",
  unsupportedScheme: "unsupported_scheme",
  invalidX402Version: "invalid_x402_version",
  unexpectedVerifyError: "unexpected_verify_error",
  unexpectedSettleError: "unexpected_settle_error",
  // scheme
  awaitingConfirmation: "z402_awaiting_confirmation",
  depositRequired: "z402_deposit_required",
  cumulativeMismatch: "z402_cumulative_mismatch",
  invalidSignature: "z402_invalid_signature",
  depositNotFound: "z402_deposit_not_found",
  chainUnavailable: "z402_chain_unavailable",
  depositNotToMerchant: "z402_deposit_not_to_merchant",
  depositMemoMismatch: "z402_deposit_memo_mismatch",
  depositTransparent: "z402_deposit_transparent",
  depositOtherSession: "z402_deposit_other_session",
  depositDead: "z402_deposit_dead",
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

const REASON_CODES: ReadonlySet<string> = new Set(Object.values(REASON));

export function isReasonCode(s: string): s is ReasonCode {
  return REASON_CODES.has(s);
}
