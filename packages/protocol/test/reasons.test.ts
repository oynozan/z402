import { describe, expect, it } from "vitest";
import { ChainUnavailableError, isReasonCode, ProtocolError, REASON } from "../src/index.js";

describe("REASON", () => {
  it("has exactly the 19 codes of protocol.md §8", () => {
    expect(Object.values(REASON).sort()).toEqual(
      [
        "invalid_network",
        "invalid_payload",
        "invalid_payment_requirements",
        "invalid_scheme",
        "invalid_x402_version",
        "unexpected_settle_error",
        "unexpected_verify_error",
        "unsupported_scheme",
        "z402_awaiting_confirmation",
        "z402_chain_unavailable",
        "z402_cumulative_mismatch",
        "z402_deposit_dead",
        "z402_deposit_memo_mismatch",
        "z402_deposit_not_found",
        "z402_deposit_not_to_merchant",
        "z402_deposit_other_session",
        "z402_deposit_required",
        "z402_deposit_transparent",
        "z402_invalid_signature",
      ].sort(),
    );
  });
});

describe("isReasonCode", () => {
  it("accepts a facilitator code and rejects anything else", () => {
    expect(isReasonCode("z402_deposit_dead")).toBe(true);
    expect(isReasonCode("limit_exceeded")).toBe(false);
    expect(isReasonCode("")).toBe(false);
    expect(isReasonCode("toString")).toBe(false);
  });
});

describe("ProtocolError", () => {
  it("carries the reason code and defaults the message to it", () => {
    const e = new ProtocolError(REASON.depositDead);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ProtocolError");
    expect(e.code).toBe("z402_deposit_dead");
    expect(e.message).toBe("z402_deposit_dead");
  });

  it("keeps an explicit message", () => {
    const e = new ProtocolError(REASON.invalidPayload, "cumulativeZat is not canonical");
    expect(e.code).toBe("invalid_payload");
    expect(e.message).toBe("cumulativeZat is not canonical");
  });
});

describe("ChainUnavailableError", () => {
  it("is an Error named ChainUnavailableError, distinct from ProtocolError", () => {
    const e = new ChainUnavailableError("lightwalletd down");
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProtocolError);
    expect(e.name).toBe("ChainUnavailableError");
    expect(e.message).toBe("lightwalletd down");
    expect(e.cause).toBeUndefined();
  });

  it("keeps the cause", () => {
    const cause = new Error("ECONNRESET");
    expect(new ChainUnavailableError("lightwalletd down", { cause }).cause).toBe(cause);
  });
});
