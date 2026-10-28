import { REASON } from "@z402-net/protocol";
import { describe, expect, it } from "vitest";
import { actionFor, classifyOutcome, type Action } from "../src/outcome.js";
import { context, NETWORK, requirements, snapshot, snapshotDeposit, txid } from "./fixtures.js";

const SNAP = snapshot({ cumulative: 3500n, deposits: [snapshotDeposit(txid(0xc1), "pending")] });

describe("classifyOutcome", () => {
  it("a successful settle is paid, with the snapshot and the transaction", () => {
    const o = classifyOutcome(
      context({ settleResponse: { success: true, transaction: "", network: NETWORK, extra: { session: SNAP } } }),
    );
    expect(o).toEqual({ kind: "paid", snapshot: SNAP, transaction: "" });
  });

  it("a successful settle carries the acked deposit txid", () => {
    const id = txid(0xc1);
    const o = classifyOutcome(
      context({ settleResponse: { success: true, transaction: id, network: NETWORK, extra: { session: SNAP } } }),
    );
    expect(o).toEqual({ kind: "paid", snapshot: SNAP, transaction: id });
  });

  it("a successful settle without a snapshot is paid with snapshot undefined", () => {
    const o = classifyOutcome(context({ settleResponse: { success: true, transaction: "", network: NETWORK } }));
    expect(o.kind).toBe("paid");
    expect((o as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it("a failed settle is refused via settle with the errorReason", () => {
    const o = classifyOutcome(
      context({
        settleResponse: {
          success: false,
          errorReason: REASON.cumulativeMismatch,
          transaction: "",
          network: NETWORK,
          extra: { session: SNAP },
        },
      }),
    );
    expect(o).toEqual({ kind: "refused", code: "z402_cumulative_mismatch", snapshot: SNAP, via: "settle" });
  });

  it("a failed settle with no errorReason is unexpected_settle_error", () => {
    const o = classifyOutcome(context({ settleResponse: { success: false, transaction: "", network: NETWORK } }));
    expect(o).toEqual({ kind: "refused", code: "unexpected_settle_error", via: "settle" });
  });

  it("a failed settle without errorReason or snapshot has snapshot undefined", () => {
    const o = classifyOutcome(
      context({
        settleResponse: { success: false, errorReason: "z402_cumulative_mismatch", transaction: "", network: NETWORK },
      }),
    );
    expect(o).toMatchObject({ kind: "refused", via: "settle", code: "z402_cumulative_mismatch" });
    expect((o as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it("a verify refusal is refused via verify with the matching accepts snapshot", () => {
    const o = classifyOutcome(
      context({
        paymentRequired: {
          x402Version: 2,
          error: REASON.awaitingConfirmation,
          resource: { url: "http://merchant.test/api" },
          accepts: [{ ...requirements, extra: { session: SNAP } }],
        },
      }),
    );
    expect(o).toEqual({ kind: "refused", code: "z402_awaiting_confirmation", snapshot: SNAP, via: "verify" });
  });

  it("picks the accepts entry matching scheme, network and payTo", () => {
    const other = snapshot({ cumulative: 999n });
    const o = classifyOutcome(
      context({
        paymentRequired: {
          x402Version: 2,
          error: REASON.depositRequired,
          resource: { url: "http://merchant.test/api" },
          accepts: [
            { ...requirements, scheme: "exact", extra: { session: other } },
            { ...requirements, network: "zcash:testnet", extra: { session: other } },
            { ...requirements, payTo: "uregtest1" + "p".repeat(60), extra: { session: other } },
            { ...requirements, extra: { session: SNAP } },
          ],
        },
      }),
    );
    expect(o).toEqual({ kind: "refused", code: "z402_deposit_required", snapshot: SNAP, via: "verify" });
  });

  it("a verify refusal with no matching accepts entry has snapshot undefined", () => {
    const o = classifyOutcome(
      context({
        paymentRequired: {
          x402Version: 2,
          error: REASON.depositRequired,
          resource: { url: "http://merchant.test/api" },
          accepts: [{ ...requirements, payTo: "uregtest1" + "p".repeat(60), extra: { session: SNAP } }],
        },
      }),
    );
    expect(o).toMatchObject({ kind: "refused", via: "verify", code: "z402_deposit_required" });
    expect((o as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it("a verify refusal with no error is unknown", () => {
    const o = classifyOutcome(
      context({
        paymentRequired: { x402Version: 2, resource: { url: "http://merchant.test/api" }, accepts: [requirements] },
      }),
    );
    expect(o).toEqual({ kind: "refused", code: "unknown", via: "verify" });
  });

  it("settleResponse takes precedence over paymentRequired", () => {
    const o = classifyOutcome(
      context({
        settleResponse: { success: true, transaction: "", network: NETWORK },
        paymentRequired: {
          x402Version: 2,
          error: REASON.depositRequired,
          resource: { url: "http://merchant.test/api" },
          accepts: [requirements],
        },
      }),
    );
    expect(o.kind).toBe("paid");
  });

  it("neither present is ambiguous", () => {
    expect(classifyOutcome(context({}))).toEqual({ kind: "ambiguous" });
  });

  it("a transport error alone is ambiguous", () => {
    expect(classifyOutcome(context({ error: new Error("socket hang up") }))).toEqual({ kind: "ambiguous" });
  });

  it("an invalid snapshot becomes undefined", () => {
    const bad = { ...SNAP, cumulativeZat: "-1" };
    const settle = classifyOutcome(
      context({ settleResponse: { success: true, transaction: "", network: NETWORK, extra: { session: bad } } }),
    );
    expect(settle.kind).toBe("paid");
    expect((settle as { snapshot?: unknown }).snapshot).toBeUndefined();

    const verify = classifyOutcome(
      context({
        paymentRequired: {
          x402Version: 2,
          error: REASON.cumulativeMismatch,
          resource: { url: "http://merchant.test/api" },
          accepts: [{ ...requirements, extra: { session: bad } }],
        },
      }),
    );
    expect(verify).toMatchObject({ kind: "refused", via: "verify" });
    expect((verify as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it("does not leak unknown keys of the snapshot", () => {
    const o = classifyOutcome(
      context({
        settleResponse: {
          success: true,
          transaction: "",
          network: NETWORK,
          extra: { session: { ...SNAP, extraKey: 1 } },
        },
      }),
    );
    expect(o).toEqual({ kind: "paid", snapshot: SNAP, transaction: "" });
  });
});

describe("actionFor", () => {
  const free = { isFinal: false, canDeposit: true };
  const final = { isFinal: true, canDeposit: true };
  const noDeposit = { isFinal: false, canDeposit: false };

  it("z402_awaiting_confirmation waits, and stops when final", () => {
    expect(actionFor(REASON.awaitingConfirmation, free)).toBe("wait_confirmation");
    expect(actionFor(REASON.awaitingConfirmation, final)).toBe("stop");
  });

  it("z402_deposit_required deposits, and stops without deposits or when final", () => {
    expect(actionFor(REASON.depositRequired, free)).toBe("deposit");
    expect(actionFor(REASON.depositRequired, noDeposit)).toBe("stop");
    expect(actionFor(REASON.depositRequired, final)).toBe("stop");
  });

  it("z402_cumulative_mismatch resyncs, and stops when final", () => {
    expect(actionFor(REASON.cumulativeMismatch, free)).toBe("resync");
    expect(actionFor(REASON.cumulativeMismatch, final)).toBe("stop");
  });

  it("z402_deposit_dead redeposits, and stops without deposits or when final", () => {
    expect(actionFor(REASON.depositDead, free)).toBe("redeposit");
    expect(actionFor(REASON.depositDead, noDeposit)).toBe("stop");
    expect(actionFor(REASON.depositDead, final)).toBe("stop");
  });

  it("z402_deposit_not_found checks the deposit, and stops when final", () => {
    expect(actionFor(REASON.depositNotFound, free)).toBe("check_deposit");
    expect(actionFor(REASON.depositNotFound, final)).toBe("stop");
  });

  it.each([REASON.chainUnavailable, REASON.unexpectedVerifyError, REASON.unexpectedSettleError])(
    "%s backs off, and stops when final",
    (code) => {
      expect(actionFor(code, free)).toBe("backoff");
      expect(actionFor(code, final)).toBe("stop");
    },
  );

  it.each([
    REASON.depositNotToMerchant,
    REASON.depositMemoMismatch,
    REASON.depositTransparent,
    REASON.depositOtherSession,
  ])("%s rejects the txid, even when final", (code) => {
    expect(actionFor(code, free)).toBe("reject_txid");
    expect(actionFor(code, final)).toBe("reject_txid");
    expect(actionFor(code, noDeposit)).toBe("reject_txid");
  });

  it.each([
    REASON.invalidSignature,
    REASON.invalidPayload,
    REASON.invalidPaymentRequirements,
    REASON.invalidNetwork,
    REASON.invalidScheme,
    REASON.unsupportedScheme,
    REASON.invalidX402Version,
    "No matching payment requirements",
    "???",
    "",
    "unknown",
  ])("%j is fatal, even when final", (code) => {
    expect(actionFor(code, free)).toBe("fatal");
    expect(actionFor(code, final)).toBe("fatal");
    expect(actionFor(code, noDeposit)).toBe("fatal");
  });

  it("does not confuse prototype keys with codes", () => {
    expect(actionFor("constructor", free)).toBe("fatal");
    expect(actionFor("__proto__", free)).toBe("fatal");
    expect(actionFor("toString", free)).toBe("fatal");
  });

  it("covers every protocol reason code", () => {
    const expected: Record<string, Action> = {
      invalid_payload: "fatal",
      invalid_payment_requirements: "fatal",
      invalid_network: "fatal",
      invalid_scheme: "fatal",
      unsupported_scheme: "fatal",
      invalid_x402_version: "fatal",
      unexpected_verify_error: "backoff",
      unexpected_settle_error: "backoff",
      z402_awaiting_confirmation: "wait_confirmation",
      z402_deposit_required: "deposit",
      z402_cumulative_mismatch: "resync",
      z402_invalid_signature: "fatal",
      z402_deposit_not_found: "check_deposit",
      z402_chain_unavailable: "backoff",
      z402_deposit_not_to_merchant: "reject_txid",
      z402_deposit_memo_mismatch: "reject_txid",
      z402_deposit_transparent: "reject_txid",
      z402_deposit_other_session: "reject_txid",
      z402_deposit_dead: "redeposit",
    };
    expect(Object.keys(expected).sort()).toEqual(Object.values(REASON).sort());
    for (const [code, action] of Object.entries(expected)) {
      expect(actionFor(code, free)).toBe(action);
    }
  });
});
