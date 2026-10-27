import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { NETWORK_REGTEST, parseSessionSnapshot, REASON, type SessionSnapshot } from "@z402/protocol";
import { FakeChain, MockWallet } from "@z402/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { PrepaidVoucherScheme, type ClientEvent, type PrepaidVoucherSchemeOptions } from "../src/index.js";
import { startScriptedMerchant, type ScriptedMerchant } from "./helpers/scripted-merchant.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** A snapshot that passes `parseSessionSnapshot`, for the session key the merchant just saw */
function snapshotFor(sessionKey: string, o: { cumulative?: bigint; limit?: bigint } = {}): SessionSnapshot {
  const cumulative = o.cumulative ?? 0n;
  const limit = o.limit ?? 125_000n;
  const s: SessionSnapshot = {
    sessionKey,
    cumulativeZat: cumulative.toString(),
    limitZat: limit.toString(),
    headroomZat: (limit > cumulative ? limit - cumulative : 0n).toString(),
    confirmedZat: "0",
    pendingZat: "0",
    creditZat: "0",
    tip: 1000,
    deposits: [],
  };
  if (parseSessionSnapshot(s) === null) throw new Error("test snapshot does not parse");
  return s;
}

function voucherOf(payload: PaymentPayload): { sessionKey: string; cumulativeZat: string; depositTxid?: string } {
  return payload.payload as { sessionKey: string; cumulativeZat: string; depositTxid?: string };
}

describe("stock @x402/fetch wrapper against a scripted merchant", () => {
  let merchant: ScriptedMerchant | undefined;
  let scheme: PrepaidVoucherScheme | undefined;

  afterEach(async () => {
    await scheme?.close();
    await merchant?.close();
    scheme = undefined;
    merchant = undefined;
  });

  /** The agent's whole setup: a stock client, one `register` line, and the stock wrapper */
  function paidFetchWith(wallet: MockWallet, chain: FakeChain, opts: Partial<PrepaidVoucherSchemeOptions> = {}) {
    scheme = new PrepaidVoucherScheme({ wallet, chain: chain.statusSource(), ...opts });
    return wrapFetchWithPayment(fetch, new x402Client().register(NETWORK_REGTEST, scheme));
  }

  it("one register line passes spend controls", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    const seen: PaymentPayload[] = [];
    merchant = await startScriptedMerchant((payload) => {
      seen.push(payload);
      return { kind: "settled", session: snapshotFor(voucherOf(payload).sessionKey, { cumulative: 500n }) };
    });
    const paidFetch = paidFetchWith(wallet, chain);

    const res = await paidFetch(merchant.url);

    expect(res.status).toBe(200);
    expect(merchant.hops).toBe(2);
    expect(seen).toHaveLength(1);
    const voucher = voucherOf(seen[0]!);
    expect(voucher.sessionKey).toMatch(HEX64);
    expect(voucher.cumulativeZat).toBe("500");
    expect(voucher.depositTxid).toMatch(HEX64);
    expect(wallet.sent).toHaveLength(1);
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settle.success).toBe(true);
    expect(settle.payer).toBe(voucher.sessionKey);
  });

  it("refusal is recovered with exactly one extra hop", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    const seen: PaymentPayload[] = [];
    merchant = await startScriptedMerchant((payload, n) => {
      seen.push(payload);
      const { sessionKey } = voucherOf(payload);
      if (n === 1) {
        return {
          kind: "refused",
          code: REASON.cumulativeMismatch,
          session: snapshotFor(sessionKey, { cumulative: 1000n }),
        };
      }
      return { kind: "settled", session: snapshotFor(sessionKey, { cumulative: 1500n }) };
    });
    const paidFetch = paidFetchWith(wallet, chain);

    const res = await paidFetch(merchant.url);

    expect(res.status).toBe(200);
    expect(merchant.hops).toBe(3);
    expect(seen.map((p) => voucherOf(p).cumulativeZat)).toEqual(["500", "1500"]);
    expect(wallet.sent).toHaveLength(1);
  });

  it("final refusal resolves to a 402 Response, not a throw", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    merchant = await startScriptedMerchant((payload) => ({
      kind: "refused",
      code: REASON.depositRequired,
      session: snapshotFor(voucherOf(payload).sessionKey),
    }));
    const paidFetch = paidFetchWith(wallet, chain, { maxDeposits: 1 });

    const res = await paidFetch(merchant.url);

    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error).toBe("z402_deposit_required");
    // Cheat mode has no deposit left to recover with, so the first refusal already ends the exchange
    expect(merchant.hops).toBe(2);
    expect(wallet.sent).toHaveLength(1);
  });

  it("a merchant that keeps asking for a deposit while ignoring the presented one gets exactly one", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    const events: ClientEvent[] = [];
    merchant = await startScriptedMerchant((payload) => ({
      kind: "refused",
      code: REASON.depositRequired,
      session: snapshotFor(voucherOf(payload).sessionKey),
    }));
    const paidFetch = paidFetchWith(wallet, chain, { onEvent: (e) => events.push(e) });

    const first = await paidFetch(merchant.url);
    expect(first.status).toBe(402);
    for (let i = 0; i < 2; i++) {
      await expect(paidFetch(merchant.url)).rejects.toThrow("z402_deposit_required_while_presented");
    }

    expect(wallet.sent).toHaveLength(1);
    expect(events.filter((e) => e.type === "fatal").map((e) => (e as { code: string }).code)).toEqual([
      "z402_deposit_required_while_presented",
    ]);
  });

  it("the recovery retry is the final attempt, so its refusal never waits", async () => {
    const chain = new FakeChain();
    const wallet = new MockWallet(chain);
    const events: ClientEvent[] = [];
    merchant = await startScriptedMerchant((payload, n) => {
      const { sessionKey } = voucherOf(payload);
      const session = snapshotFor(sessionKey, { cumulative: 1000n });
      return n === 1
        ? { kind: "refused", code: REASON.cumulativeMismatch, session }
        : { kind: "refused", code: REASON.awaitingConfirmation, session };
    });
    // A non-final awaiting_confirmation would poll the chain here, so a short wait keeps a regression quick
    const paidFetch = paidFetchWith(wallet, chain, {
      confirmationWaitMs: 20,
      pollIntervalMs: 5,
      onEvent: (e) => events.push(e),
    });

    const res = await paidFetch(merchant.url);

    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error).toBe("z402_awaiting_confirmation");
    expect(merchant.hops).toBe(3);
    expect(events.filter((e) => e.type === "waiting")).toEqual([]);
    expect(wallet.sent).toHaveLength(1);
  });
});
