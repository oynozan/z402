import type { PaymentResponseContext } from "@x402/core/client";
import type { PaymentPayloadResult, PaymentRequirements } from "@x402/core/types";
import {
  DEMO_TERMS,
  depositMemo,
  encodeTerms,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseSessionSnapshot,
  publicKeyFromSeed,
  REASON,
  SCHEME,
  verifyVoucher,
  type DepositRequest,
  type DepositStatus,
  type SessionSnapshot,
  type SnapshotDeposit,
  type TxStatusSource,
  type ZcashWallet,
} from "@z402/protocol";
import { FakeChain, MockWallet } from "@z402/testkit";
import { describe, expect, it } from "vitest";
import {
  DepositStatusUnknownError,
  DepositUncertainError,
  PrepaidVoucherScheme,
  type ClientEvent,
  type PrepaidVoucherSchemeOptions,
} from "../src/index.js";
import { PAY_TO, SEED } from "./fixtures.js";
import { flush, ManualClock } from "./manual-clock.js";

const SESSION_KEY = publicKeyFromSeed(SEED);
const WINDOW = DEMO_TERMS.windowZat;
const RESOURCE = "http://merchant.test/chunk";

/** A fresh protocol.md §2 entry per call, as the stock wrapper decodes each 402 anew */
function makeReq(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: NETWORK_REGTEST,
    amount: "500",
    asset: "ZEC",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { ...encodeTerms(DEMO_TERMS), termsVersion: "0123456789abcdef" },
    ...over,
  };
}

interface Voucher {
  sessionKey: string;
  cumulativeZat: string;
  sig: string;
  depositTxid?: string;
}

function voucher(r: PaymentPayloadResult): Voucher {
  return r.payload as unknown as Voucher;
}

function dep(txid: string, status: DepositStatus): SnapshotDeposit {
  const confirmations = status === "pending" ? 0 : 1;
  return { txid, valueZat: "100000", status, confirmations, expiryHeight: 1121, zeroConf: true };
}

/** A snapshot that passes `parseSessionSnapshot`, for this test's session */
function snap(cumulative = 0n, limit = 0n, deposits: SnapshotDeposit[] = []): SessionSnapshot {
  const s: SessionSnapshot = {
    sessionKey: SESSION_KEY,
    cumulativeZat: cumulative.toString(),
    limitZat: limit.toString(),
    headroomZat: (limit > cumulative ? limit - cumulative : 0n).toString(),
    confirmedZat: "0",
    pendingZat: "0",
    creditZat: "0",
    tip: 1000,
    deposits,
  };
  if (parseSessionSnapshot(s) === null) throw new Error("test snapshot does not parse");
  return s;
}

function base(R: PaymentRequirements, r: PaymentPayloadResult): PaymentResponseContext {
  return {
    paymentPayload: { x402Version: r.x402Version, accepted: R, payload: r.payload, resource: { url: RESOURCE } },
    requirements: R,
  };
}

function paid(
  R: PaymentRequirements,
  r: PaymentPayloadResult,
  o: { transaction?: string; session?: SessionSnapshot } = {},
): PaymentResponseContext {
  return {
    ...base(R, r),
    settleResponse: {
      success: true,
      transaction: o.transaction ?? "",
      network: R.network,
      payer: SESSION_KEY,
      ...(o.session === undefined ? {} : { extra: { session: o.session } }),
    },
  };
}

function settleRefused(
  R: PaymentRequirements,
  r: PaymentPayloadResult,
  code: string,
  o: { transaction?: string; session?: SessionSnapshot } = {},
): PaymentResponseContext {
  return {
    ...base(R, r),
    settleResponse: {
      success: false,
      errorReason: code,
      transaction: o.transaction ?? "",
      network: R.network,
      ...(o.session === undefined ? {} : { extra: { session: o.session } }),
    },
  };
}

function refused(
  R: PaymentRequirements,
  r: PaymentPayloadResult,
  code: string,
  session?: SessionSnapshot,
): PaymentResponseContext {
  return {
    ...base(R, r),
    paymentRequired: {
      x402Version: 2,
      error: code,
      resource: { url: RESOURCE },
      accepts: [{ ...R, extra: { ...R.extra, ...(session === undefined ? {} : { session }) } }],
    },
  };
}

function track<T>(p: Promise<T>): { readonly done: boolean; readonly value: T | undefined } {
  const box: { done: boolean; value: T | undefined } = { done: false, value: undefined };
  void p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
}

/** Holds every `sendDeposit` at a gate the test opens, to observe in-flight deposits */
class GatedWallet implements ZcashWallet {
  calls = 0;
  readonly inner: MockWallet;
  #gate: Promise<void> | undefined;
  #open: (() => void) | undefined;

  constructor(inner: MockWallet) {
    this.inner = inner;
  }

  shut(): void {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  open(): void {
    this.#open?.();
    this.#gate = undefined;
  }

  async sendDeposit(req: DepositRequest): Promise<{ txid: string }> {
    this.calls += 1;
    if (this.#gate !== undefined) await this.#gate;
    return this.inner.sendDeposit(req);
  }
}

type Options = Partial<Omit<PrepaidVoucherSchemeOptions, "wallet" | "chain" | "clock" | "seed" | "onEvent">>;

function setup(o: Options & { wallet?: ZcashWallet; source?: TxStatusSource; chain?: FakeChain } = {}) {
  const { wallet: customWallet, source, chain: customChain, ...options } = o;
  const chain = customChain ?? new FakeChain();
  const mock = new MockWallet(chain);
  const clock = new ManualClock();
  const events: ClientEvent[] = [];
  const scheme = new PrepaidVoucherScheme({
    wallet: customWallet ?? mock,
    chain: source ?? chain.statusSource(),
    clock,
    seed: SEED,
    onEvent: (e) => events.push(e),
    ...options,
  });
  const hook = (ctx: PaymentResponseContext) => scheme.schemeHooks.onPaymentResponse(ctx);
  const pay = (R: PaymentRequirements) => scheme.createPaymentPayload(2, R);
  return { chain, wallet: mock, clock, events, scheme, hook, pay };
}

function ofType<K extends ClientEvent["type"]>(events: ClientEvent[], type: K): Extract<ClientEvent, { type: K }>[] {
  return events.filter((e): e is Extract<ClientEvent, { type: K }> => e.type === type);
}

describe("PrepaidVoucherScheme basics", () => {
  it("is the prepaid-voucher scheme", () => {
    expect(setup().scheme.scheme).toBe(SCHEME);
  });

  it("findDefaultAsset knows ZEC on zcash networks only", () => {
    const { scheme } = setup();
    expect(scheme.findDefaultAsset("ZEC", "zcash:testnet")).toEqual({ asset: "ZEC", decimals: 8, symbol: "ZEC" });
    expect(scheme.findDefaultAsset("ZEC", "zcash:regtest")).toEqual({ asset: "ZEC", decimals: 8, symbol: "ZEC" });
    expect(scheme.findDefaultAsset("USDC", "eip155:1")).toBeUndefined();
    expect(scheme.findDefaultAsset("ZEC", "eip155:1")).toBeUndefined();
    expect(scheme.findDefaultAsset("USDC", "zcash:testnet")).toBeUndefined();
  });

  it("the hook works detached from the scheme object, as x402Client calls it", async () => {
    const { scheme, pay } = setup();
    const R = makeReq();
    const r = await pay(R);
    const { onPaymentResponse } = scheme.schemeHooks;
    await expect(onPaymentResponse(paid(R, r, { session: snap(500n, 125_000n) }))).resolves.toBeUndefined();
    expect(scheme.session(PAY_TO)?.cumulativeZat).toBe(500n);
  });
});

describe("requirement validation (spend safety)", () => {
  const cases: Array<[string, Partial<PaymentRequirements>, { maxAmountPerPayment?: string } | undefined, RegExp]> = [
    [
      "windowZat above the default maxDepositZat",
      { extra: { ...encodeTerms({ ...DEMO_TERMS, windowZat: 2_000_000n }) } },
      undefined,
      /windowZat/,
    ],
    [
      "a transparent-including payTo",
      { network: NETWORK_TESTNET, payTo: "tutest1" + "q".repeat(60) },
      undefined,
      /payTo/,
    ],
    ["an amount above the window", { amount: "200000" }, undefined, /amount/],
    ["a window above ctx.maxAmountPerPayment", {}, { maxAmountPerPayment: "50000" }, /maxAmountPerPayment/],
    ["another scheme", { scheme: "exact" }, undefined, /scheme/],
    ["a non-zcash network", { network: "eip155:1" }, undefined, /network/],
    ["a payTo of another network", { payTo: "utest1" + "q".repeat(60) }, undefined, /payTo/],
    ["a zero amount", { amount: "0" }, undefined, /amount/],
    ["a non-canonical amount", { amount: "0500" }, undefined, /amount/],
    ["missing terms", { extra: {} }, undefined, /extra/],
    ["another asset", { asset: "USDC" }, undefined, /asset/],
    ["a malformed maxAmountPerPayment", {}, { maxAmountPerPayment: "1e9" }, /maxAmountPerPayment/],
  ];

  it.each(cases)("rejects %s before touching the wallet", async (_name, over, ctx, message) => {
    const { scheme, wallet, events } = setup();
    await expect(scheme.createPaymentPayload(2, makeReq(over), ctx)).rejects.toThrow(message);
    expect(wallet.sent).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("a rejection takes no lock: the next valid call goes through", async () => {
    const { scheme, pay } = setup();
    await expect(scheme.createPaymentPayload(2, makeReq({ amount: "200000" }))).rejects.toThrow();
    await expect(pay(makeReq())).resolves.toBeDefined();
  });

  it("accepts a window up to maxDepositZat and maxAmountPerPayment", async () => {
    const { scheme, wallet } = setup({ maxDepositZat: WINDOW });
    await expect(
      scheme.createPaymentPayload(2, makeReq(), { maxAmountPerPayment: WINDOW.toString() }),
    ).resolves.toBeDefined();
    expect(wallet.sent).toHaveLength(1);
  });

  it("honours a lower maxDepositZat option", async () => {
    const { scheme, wallet } = setup({ maxDepositZat: WINDOW - 1n });
    await expect(scheme.createPaymentPayload(2, makeReq())).rejects.toThrow(/maxDepositZat/);
    expect(wallet.sent).toHaveLength(0);
  });
});

describe("createPaymentPayload", () => {
  it("call 1 deposits inline and attaches the txid", async () => {
    const { wallet, events, pay } = setup();
    const R = makeReq();
    const r = await pay(R);

    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]).toEqual({ to: PAY_TO, amountZat: 100_000n, memo: SESSION_KEY + ":1" });
    const [broadcast] = ofType(events, "deposit_broadcast");
    const v = voucher(r);
    expect(v.depositTxid).toBe(broadcast?.txid);
    expect(v.cumulativeZat).toBe("500");
    expect(v.sessionKey).toBe(SESSION_KEY);
    expect(verifyVoucher(v, { scheme: SCHEME, network: NETWORK_REGTEST, payTo: PAY_TO })).toBe(true);
    expect(r.x402Version).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["session", "deposit_started", "deposit_broadcast", "voucher"]);
    expect(events[1]).toEqual({ type: "deposit_started", index: 1, inline: true });
    expect(events[3]).toEqual({ type: "voucher", cumulativeZat: "500", depositTxid: v.depositTxid });
  });

  it("returns the x402Version it was given", async () => {
    const { scheme } = setup();
    expect((await scheme.createPaymentPayload(7, makeReq())).x402Version).toBe(7);
  });

  it("paid settle resyncs and acks", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    const session = snap(500n, 125_000n, [dep(t1, "pending")]);
    await expect(hook(paid(R, r1, { transaction: t1, session }))).resolves.toBeUndefined();
    expect(ofType(events, "deposit_acked")).toEqual([{ type: "deposit_acked", txid: t1 }]);
    expect(ofType(events, "paid")).toEqual([{ type: "paid", cumulativeZat: "500", snapshot: session }]);

    const r2 = await pay(makeReq());
    expect(voucher(r2).cumulativeZat).toBe("1000");
    expect(voucher(r2).depositTxid).toBeUndefined();
  });

  it("a paid settle without a snapshot advances cumulative to the attempted value", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await hook(paid(R, r1));
    expect(voucher(await pay(makeReq())).cumulativeZat).toBe("1000");
  });

  it("resends the txid until acked", async () => {
    const { hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;

    await hook(paid(R1, r1, { transaction: "", session: snap(500n, 125_000n) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    expect(voucher(r2).depositTxid).toBe(t1);

    await hook(paid(R2, r2, { transaction: "", session: snap(1000n, 125_000n, [dep(t1, "confirmed")]) }));
    expect(voucher(await pay(makeReq())).depositTxid).toBeUndefined();
  });

  it("an inline deposit failure rejects the payload, records the deposit failed and releases the lock", async () => {
    const { scheme, wallet, events, pay } = setup();
    wallet.failNextWith(new Error("wallet offline"));
    await expect(pay(makeReq())).rejects.toThrow("wallet offline");
    expect(ofType(events, "deposit_failed")).toEqual([
      { type: "deposit_failed", index: 1, error: new Error("wallet offline") },
    ]);
    expect(scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["failed"]);

    const r = await pay(makeReq());
    expect(wallet.sent.map((s) => s.memo)).toEqual([SESSION_KEY + ":2"]);
    expect(voucher(r).depositTxid).toBeDefined();
  });

  it("concurrent payloads are serialized: the second starts only after the first's hook ran", async () => {
    const { wallet, events, hook, pay } = setup();
    const R1 = makeReq();
    const R2 = makeReq();
    const p1 = pay(R1);
    const second = track(pay(R2));
    const r1 = await p1;
    const t1 = voucher(r1).depositTxid as string;
    await flush();
    expect(second.done).toBe(false);
    expect(ofType(events, "voucher")).toHaveLength(1);

    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 125_000n, [dep(t1, "pending")]) }));
    await flush();
    expect(second.done).toBe(true);
    expect(voucher(second.value as PaymentPayloadResult).cumulativeZat).toBe("1000");
    expect(wallet.sent).toHaveLength(1);
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf("voucher")).toBeGreaterThan(types.indexOf("paid"));
  });

  it("safety release frees the mutex and advances cumulative after 120 s without a hook", async () => {
    const { clock, events, pay } = setup();
    const p1 = pay(makeReq());
    const second = track(pay(makeReq()));
    const r1 = await p1;

    await clock.advance(119_999);
    expect(second.done).toBe(false);

    await clock.advance(1);
    expect(second.done).toBe(true);
    const first = BigInt(voucher(r1).cumulativeZat);
    expect(voucher(second.value as PaymentPayloadResult).cumulativeZat).toBe((first + 500n).toString());
    expect(ofType(events, "ambiguous")).toEqual([{ type: "ambiguous", attemptedZat: "500" }]);
  });

  it("a late hook after a safety release is ignored and leaves the next holder's lock alone", async () => {
    const { clock, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const R2 = makeReq();
    const p2 = pay(R2);
    await clock.advance(120_000);
    const r2 = await p2;

    const third = track(pay(makeReq()));
    await expect(hook(paid(R1, r1, { session: snap(500n, 125_000n) }))).resolves.toBeUndefined();
    await flush();
    expect(third.done).toBe(false);

    await hook(paid(R2, r2, { session: snap(1000n, 125_000n) }));
    await flush();
    expect(third.done).toBe(true);
    expect(voucher(third.value as PaymentPayloadResult).cumulativeZat).toBe("1500");
  });

  it("the hook cancels the safety timer", async () => {
    const { clock, hook, pay } = setup();
    const R = makeReq();
    const r = await pay(R);
    expect(clock.pendingTimers).toBe(1);
    await hook(paid(R, r, { session: snap(500n, 125_000n) }));
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("onPaymentResponse refusals", () => {
  it("awaiting_confirmation waits for a block then recovers", async () => {
    const { chain, clock, wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    const session = snap(0n, 0n, [dep(t1, "pending")]);
    const h = track(hook(refused(R, r1, REASON.awaitingConfirmation, session)));
    await flush();
    expect(h.done).toBe(false);
    expect(ofType(events, "refused")).toEqual([
      { type: "refused", code: REASON.awaitingConfirmation, snapshot: session, recovering: true },
    ]);
    expect(ofType(events, "waiting")).toEqual([{ type: "waiting", txid: t1 }]);

    chain.mine();
    await clock.advance(2_000);
    expect(h.done).toBe(false);
    expect(ofType(events, "deposit_confirmed")).toEqual([
      { type: "deposit_confirmed", txid: t1, index: 1, height: chain.height },
    ]);

    await clock.advance(6_000);
    expect(h.done).toBe(true);
    expect(h.value).toEqual({ recovered: true });
    expect(wallet.sent).toHaveLength(1);

    const retry = await pay(R);
    expect(voucher(retry).cumulativeZat).toBe("500");
  });

  it("awaiting_confirmation gives up at confirmationWaitMs without paying", async () => {
    const { clock, wallet, hook, pay } = setup({ confirmationWaitMs: 10_000 });
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    const h = track(hook(refused(R, r1, REASON.awaitingConfirmation, snap(0n, 0n, [dep(t1, "pending")]))));
    await clock.advance(9_999);
    expect(h.done).toBe(false);
    await clock.advance(1);
    expect(h.done).toBe(true);
    expect(h.value).toBeUndefined();
    expect(wallet.sent).toHaveLength(1);
  });

  it("awaiting_confirmation redeposits when the pending deposit dies", async () => {
    const chain = new FakeChain({ expiryDelta: 3 });
    const { clock, wallet, events, hook, pay } = setup({ chain });
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    chain.hold(t1);
    const h = track(hook(refused(R, r1, REASON.awaitingConfirmation, snap(0n, 0n, [dep(t1, "pending")]))));
    await flush();

    chain.mine(4);
    await clock.advance(2_000);
    expect(h.value).toEqual({ recovered: true });
    expect(ofType(events, "deposit_dead")).toEqual([{ type: "deposit_dead", txid: t1 }]);
    expect(wallet.sent.map((s) => s.memo)).toEqual([SESSION_KEY + ":1", SESSION_KEY + ":2"]);
    const retry = await pay(R);
    expect(voucher(retry).depositTxid).not.toBe(t1);
    expect(voucher(retry).depositTxid).toBeDefined();
  });

  it("final attempt never waits", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await expect(hook(refused(R, r1, REASON.cumulativeMismatch, snap(0n)))).resolves.toEqual({
      recovered: true,
    });

    const r2 = await pay(R);
    const h = track(hook(refused(R, r2, REASON.awaitingConfirmation, snap(0n, 0n, [dep(t1, "pending")]))));
    await flush();
    expect(h.done).toBe(true);
    expect(h.value).toBeUndefined();
  });

  it("a new requirements object is not a final attempt", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await hook(refused(R, r1, REASON.cumulativeMismatch, snap(0n)));
    const r1b = await pay(R);
    await hook(paid(R, r1b, { session: snap(500n, 500n, [dep(t1, "pending")]) }));

    const R2 = makeReq();
    const r2 = await pay(R2);
    const h = track(hook(refused(R2, r2, REASON.awaitingConfirmation, snap(500n, 500n, [dep(t1, "pending")]))));
    await flush();
    expect(h.done).toBe(false);
  });

  it("deposit_required deposits then recovers", async () => {
    const { wallet, hook, pay, events } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 125_000n, [dep(t1, "confirmed")]) }));
    expect(wallet.sent).toHaveLength(1);

    const R = makeReq();
    const r2 = await pay(R);
    expect(voucher(r2).depositTxid).toBeUndefined();
    const session = snap(125_000n, 125_000n, [dep(t1, "confirmed")]);
    await expect(hook(refused(R, r2, REASON.depositRequired, session))).resolves.toEqual({ recovered: true });
    expect(wallet.sent).toHaveLength(2);
    expect(wallet.sent[1]?.memo).toBe(depositMemo(SESSION_KEY, 2));
    const [, second] = ofType(events, "deposit_broadcast");

    const retry = await pay(R);
    expect(voucher(retry).depositTxid).toBe(second?.txid);
    expect(voucher(retry).cumulativeZat).toBe("125500");
  });

  it("deposit_required does not pay again for a deposit the attempt did not present yet", async () => {
    const gated = new GatedWallet(new MockWallet(new FakeChain()));
    const { events, hook, pay } = setup({ wallet: gated });
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    gated.shut();
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "confirmed")]) }));
    expect(gated.calls).toBe(2);

    const R2 = makeReq();
    const r2 = await pay(R2);
    expect(voucher(r2).depositTxid).toBeUndefined();
    gated.open();
    await flush();

    await expect(
      hook(refused(R2, r2, REASON.depositRequired, snap(500n, 500n, [dep(t1, "confirmed")]))),
    ).resolves.toEqual({ recovered: true });
    expect(gated.calls).toBe(2);
    const [, second] = ofType(events, "deposit_broadcast");
    expect(voucher(await pay(R2)).depositTxid).toBe(second?.txid);
  });

  it("cheat mode stops at the limit", async () => {
    const { wallet, events, hook, pay } = setup({ maxDeposits: 1 });
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R1, r1, { transaction: t1, session: snap(124_500n, 125_000n, [dep(t1, "confirmed")]) }));
    const R = makeReq();
    const r2 = await pay(R);
    const session = snap(125_000n, 125_000n, [dep(t1, "confirmed")]);
    await expect(hook(refused(R, r2, REASON.depositRequired, session))).resolves.toBeUndefined();
    expect(ofType(events, "refused")).toEqual([
      { type: "refused", code: REASON.depositRequired, snapshot: session, recovering: false },
    ]);
    expect(ofType(events, "fatal")).toEqual([]);
    expect(wallet.sent).toHaveLength(1);
  });

  it("deposit_required on the final attempt starts a background deposit and returns", async () => {
    const { wallet, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 125_000n, [dep(t1, "confirmed")]) }));
    const R = makeReq();
    const r2 = await pay(R);
    await hook(refused(R, r2, REASON.cumulativeMismatch, snap(1000n, 125_000n, [dep(t1, "confirmed")])));
    const r3 = await pay(R);
    expect(wallet.sent).toHaveLength(1);
    const session = snap(125_000n, 125_000n, [dep(t1, "confirmed")]);
    await expect(hook(refused(R, r3, REASON.depositRequired, session))).resolves.toBeUndefined();
    await flush();
    expect(wallet.sent).toHaveLength(2);
  });

  it("cumulative_mismatch resyncs", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await expect(hook(refused(R, r1, REASON.cumulativeMismatch, snap(7000n, 125_000n)))).resolves.toEqual({
      recovered: true,
    });
    expect(voucher(await pay(R)).cumulativeZat).toBe("7500");
  });

  it("cumulative_mismatch without a snapshot does not recover", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await expect(hook(refused(R, r1, REASON.cumulativeMismatch))).resolves.toBeUndefined();
  });

  it("a settle refusal applies its snapshot before acting", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await expect(
      hook(settleRefused(R, r1, REASON.cumulativeMismatch, { session: snap(7000n, 125_000n) })),
    ).resolves.toEqual({ recovered: true });
    expect(voucher(await pay(R)).cumulativeZat).toBe("7500");
  });

  it("a failed settle does not ack, even with our txid as its transaction, so the retry resends it", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await hook(settleRefused(R, r1, REASON.cumulativeMismatch, { transaction: t1, session: snap(500n, 125_000n) }));
    const retry = await pay(R);
    expect(voucher(retry).depositTxid).toBe(t1);
    expect(voucher(retry).cumulativeZat).toBe("1000");
    expect(ofType(events, "deposit_acked")).toEqual([]);
  });

  it("deposit_dead redeposits with the next index once our own chain has lost the tx too", async () => {
    const { chain, wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    chain.drop(t1);
    await expect(hook(refused(R, r1, REASON.depositDead, snap(0n, 0n, [dep(t1, "dead")])))).resolves.toEqual({
      recovered: true,
    });
    expect(ofType(events, "deposit_dead")).toEqual([{ type: "deposit_dead", txid: t1 }]);
    expect(wallet.sent.map((s) => s.memo)).toEqual([depositMemo(SESSION_KEY, 1), depositMemo(SESSION_KEY, 2)]);
    const [, second] = ofType(events, "deposit_broadcast");
    expect(voucher(await pay(R)).depositTxid).toBe(second?.txid);
  });

  it("deposit_dead without a snapshot marks the presented txid dead", async () => {
    const { chain, scheme, wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    chain.drop(voucher(r1).depositTxid as string);
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toEqual({ recovered: true });
    expect(scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["dead", "sent"]);
    expect(wallet.sent).toHaveLength(2);
  });

  it("deposit_dead in cheat mode marks it dead and stops", async () => {
    const { chain, scheme, wallet, hook, pay } = setup({ maxDeposits: 1 });
    const R = makeReq();
    const r1 = await pay(R);
    chain.drop(voucher(r1).depositTxid as string);
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toBeUndefined();
    expect(scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["dead"]);
    expect(wallet.sent).toHaveLength(1);
  });

  it("deposit_not_found recovers 2 s after seeing the tx itself", async () => {
    const { clock, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const h = track(hook(refused(R, r1, REASON.depositNotFound, snap())));
    await clock.advance(1_999);
    expect(h.done).toBe(false);
    await clock.advance(1);
    expect(h.value).toEqual({ recovered: true });
    expect(ofType(events, "waiting")).toHaveLength(1);
  });

  it("deposit_not_found treats a tx gone for 120 s and 2 blocks as dead and redeposits", async () => {
    const { chain, clock, wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    chain.drop(t1);
    const h = track(hook(refused(R, r1, REASON.depositNotFound, snap())));
    await flush();
    chain.mine(2);
    await clock.advance(118_000);
    expect(h.done).toBe(false);
    await clock.advance(2_000);
    expect(h.value).toEqual({ recovered: true });
    expect(ofType(events, "deposit_dead")).toEqual([{ type: "deposit_dead", txid: t1 }]);
    expect(wallet.sent).toHaveLength(2);
  });

  it.each<[string, number]>([
    [REASON.chainUnavailable, 5_000],
    [REASON.unexpectedVerifyError, 1_000],
    [REASON.unexpectedSettleError, 1_000],
  ])("%s backs off %i ms then recovers", async (code, ms) => {
    const { clock, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const h = track(hook(refused(R, r1, code)));
    await clock.advance(ms - 1);
    expect(h.done).toBe(false);
    await clock.advance(1);
    expect(h.value).toEqual({ recovered: true });
  });

  it.each([
    REASON.depositNotToMerchant,
    REASON.depositMemoMismatch,
    REASON.depositTransparent,
    REASON.depositOtherSession,
  ])(
    "%s rejects the txid for good and reports it fatal",
    async (code) => {
      const { scheme, events, hook, pay } = setup();
      const R = makeReq();
      const r1 = await pay(R);
      await expect(hook(refused(R, r1, code, snap()))).resolves.toBeUndefined();
      expect(scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["rejected"]);
      expect(ofType(events, "fatal")).toEqual([{ type: "fatal", code, message: code }]);
    },
  );

  it.each([REASON.invalidSignature, REASON.invalidPayload, "Payment required", "unknown"])(
    "%s is fatal and does not recover",
    async (code) => {
      const { events, hook, pay } = setup();
      const R = makeReq();
      const r1 = await pay(R);
      await expect(hook(refused(R, r1, code))).resolves.toBeUndefined();
      expect(ofType(events, "fatal")).toEqual([{ type: "fatal", code, message: code }]);
    },
  );

  it("a fatal settle refusal reports its errorMessage", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const ctx = settleRefused(R, r1, REASON.invalidSignature);
    if (ctx.settleResponse) ctx.settleResponse.errorMessage = "bad sig";
    await hook(ctx);
    expect(ofType(events, "fatal")).toEqual([{ type: "fatal", code: REASON.invalidSignature, message: "bad sig" }]);
  });
});

describe("acks come only from a successful settle (protocol.md §7.3)", () => {
  it("after a refusal whose snapshot lists our unacked txid as pending, the recovered retry still carries it", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    const projected = snap(7000n, 125_000n, [dep(t1, "pending")]);
    await expect(hook(refused(R, r1, REASON.cumulativeMismatch, projected))).resolves.toEqual({ recovered: true });
    expect(ofType(events, "deposit_acked")).toEqual([]);

    const retry = await pay(R);
    expect(voucher(retry).depositTxid).toBe(t1);
    expect(voucher(retry).cumulativeZat).toBe("7500");
  });

  it("a settle refusal's snapshot listing our txid does not ack it either", async () => {
    const { hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await hook(settleRefused(R, r1, REASON.cumulativeMismatch, { session: snap(7000n, 125_000n, [dep(t1, "confirmed")]) }));
    expect(voucher(await pay(R)).depositTxid).toBe(t1);
  });

  it("after a successful settle whose snapshot lists it, the next voucher no longer carries it", async () => {
    const { events, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(refused(R1, r1, REASON.cumulativeMismatch, snap(0n, 125_000n, [dep(t1, "pending")])));
    const retry = await pay(R1);
    expect(voucher(retry).depositTxid).toBe(t1);

    await hook(paid(R1, retry, { transaction: "", session: snap(500n, 100_000n, [dep(t1, "pending")]) }));
    expect(ofType(events, "deposit_acked")).toEqual([{ type: "deposit_acked", txid: t1 }]);
    expect(voucher(await pay(makeReq())).depositTxid).toBeUndefined();
  });
});

describe("a deposit request while the presented deposit is unaccounted for", () => {
  const HALT = "z402_deposit_required_while_presented";

  it.each<[string, (t1: string) => SessionSnapshot | undefined]>([
    ["with no snapshot", () => undefined],
    ["with a snapshot that does not list it", () => snap(0n, 0n)],
    ["with a snapshot that lists it as pending", (t1) => snap(0n, 0n, [dep(t1, "pending")])],
    ["with a snapshot that lists it as confirmed", (t1) => snap(125_000n, 125_000n, [dep(t1, "confirmed")])],
  ])("halts %s instead of paying again", async (_name, session) => {
    const { wallet, clock, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    await expect(hook(refused(R, r1, REASON.depositRequired, session(t1)))).resolves.toBeUndefined();

    expect(wallet.sent).toHaveLength(1);
    expect(ofType(events, "refused")).toMatchObject([{ code: REASON.depositRequired, recovering: false }]);
    const fatal = ofType(events, "fatal");
    expect(fatal).toHaveLength(1);
    expect(fatal[0]!.code).toBe(HALT);
    expect(fatal[0]!.message).toContain(t1);
    const next = pay(makeReq());
    await expect(next).rejects.toThrow(HALT);
    await expect(next).rejects.toThrow(t1);
    await flush();
    expect(wallet.sent).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("halts on the final attempt too, without a background deposit", async () => {
    const { wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await hook(refused(R, r1, REASON.cumulativeMismatch, snap(1000n, 125_000n)));
    const r2 = await pay(R);
    expect(voucher(r2).depositTxid).toBe(t1);

    await expect(hook(refused(R, r2, REASON.depositRequired, snap(125_000n, 125_000n)))).resolves.toBeUndefined();
    await flush();
    expect(wallet.sent).toHaveLength(1);
    expect(ofType(events, "fatal").map((e) => e.code)).toEqual([HALT]);
  });

  it("a facilitator that keeps asking never gets a second deposit", async () => {
    const { wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await hook(refused(R, r1, REASON.depositRequired, snap(0n, 0n)));
    for (let i = 0; i < 3; i++) await expect(pay(makeReq())).rejects.toThrow(HALT);
    expect(wallet.sent).toHaveLength(1);
  });

  it.each(["dead", "orphaned"] as const)("still deposits again when the snapshot lists the presented txid as %s", async (status) => {
    const { wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    await expect(hook(refused(R, r1, REASON.depositRequired, snap(0n, 0n, [dep(t1, status)])))).resolves.toEqual({
      recovered: true,
    });
    expect(wallet.sent).toHaveLength(2);
    expect(ofType(events, "fatal")).toEqual([]);
    const [, second] = ofType(events, "deposit_broadcast");
    expect(voucher(await pay(R)).depositTxid).toBe(second?.txid);
  });
});

describe("deposit_dead for a deposit our own chain still sees", () => {
  const HALT = "z402_deposit_dead_but_alive";

  it("halts without a redeposit while the tx is in the mempool before its expiry", async () => {
    const { wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    await expect(hook(refused(R, r1, REASON.depositDead, snap(0n, 0n, [dep(t1, "dead")])))).resolves.toBeUndefined();

    expect(wallet.sent).toHaveLength(1);
    const fatal = ofType(events, "fatal");
    expect(fatal.map((e) => e.code)).toEqual([HALT]);
    expect(fatal[0]!.message).toContain(t1);
    await expect(pay(makeReq())).rejects.toThrow(HALT);
    expect(wallet.sent).toHaveLength(1);
  });

  it("halts when the tx is already mined", async () => {
    const { chain, wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    chain.mine();
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toBeUndefined();
    await expect(pay(makeReq())).rejects.toThrow(HALT);
    expect(wallet.sent).toHaveLength(1);
  });

  it("halts on the final attempt too, without a background deposit", async () => {
    const { wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await hook(refused(R, r1, REASON.cumulativeMismatch, snap(1000n, 125_000n)));
    const r2 = await pay(R);
    await expect(hook(refused(R, r2, REASON.depositDead))).resolves.toBeUndefined();
    await flush();
    expect(wallet.sent).toHaveLength(1);
    await expect(pay(makeReq())).rejects.toThrow(HALT);
  });

  it("redeposits when our chain still lists the tx in the mempool at its expiry", async () => {
    const chain = new FakeChain();
    const inner = chain.statusSource();
    let stale: string | undefined;
    const source: TxStatusSource = {
      tip: () => inner.tip(),
      status: async (txid) =>
        txid === stale
          ? { found: true, location: "mempool", minedHeight: null, expiryHeight: chain.height }
          : inner.status(txid),
    };
    const { wallet, events, hook, pay } = setup({ chain, source });
    const R = makeReq();
    const r1 = await pay(R);
    stale = voucher(r1).depositTxid as string;
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toEqual({ recovered: true });
    expect(wallet.sent).toHaveLength(2);
    expect(ofType(events, "fatal")).toEqual([]);
  });

  it("redeposits when our chain has the tx orphaned", async () => {
    const { chain, wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    chain.mine();
    chain.orphan(voucher(r1).depositTxid as string);
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toEqual({ recovered: true });
    expect(wallet.sent).toHaveLength(2);
  });

  it("keeps the redeposit when our chain cannot answer", async () => {
    const { chain, wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    chain.setUnavailable(true);
    await expect(hook(refused(R, r1, REASON.depositDead))).resolves.toEqual({ recovered: true });
    expect(wallet.sent).toHaveLength(2);
    expect(ofType(events, "fatal")).toEqual([]);
  });
});

describe("snapshots of another session", () => {
  const FOREIGN = "ab".repeat(32);
  const foreign = (cumulative: bigint, deposits: SnapshotDeposit[] = []): SessionSnapshot => ({
    ...snap(cumulative, 125_000n, deposits),
    sessionKey: FOREIGN,
  });

  it("a paid settle ignores it, falls back to the attempted value and reports it", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;

    await expect(hook(paid(R, r1, { session: foreign(7000n, [dep(t1, "pending")]) }))).resolves.toBeUndefined();

    expect(ofType(events, "fatal")).toMatchObject([{ type: "fatal", code: "snapshot_session_mismatch" }]);
    expect(ofType(events, "paid")).toEqual([{ type: "paid", cumulativeZat: "500" }]);
    expect(ofType(events, "deposit_acked")).toEqual([]);
    const next = await pay(makeReq());
    expect(voucher(next).cumulativeZat).toBe("1000");
    expect(voucher(next).depositTxid).toBe(t1);
  });

  it("a refusal does not resync from it, so cumulative_mismatch has nothing to recover with", async () => {
    const { scheme, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);

    await expect(hook(refused(R, r1, REASON.cumulativeMismatch, foreign(7000n)))).resolves.toBeUndefined();

    expect(ofType(events, "fatal")).toMatchObject([{ type: "fatal", code: "snapshot_session_mismatch" }]);
    expect(ofType(events, "refused")).toEqual([{ type: "refused", code: REASON.cumulativeMismatch, recovering: false }]);
    expect(scheme.session(PAY_TO)?.snapshot).toBeUndefined();
    expect(voucher(await pay(makeReq())).cumulativeZat).toBe("500");
  });

  it("a refusal does not copy its dead statuses", async () => {
    const { scheme, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 125_000n, [dep(t1, "pending")]) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    await hook(refused(R2, r2, REASON.cumulativeMismatch, foreign(500n, [dep(t1, "dead")])));
    expect(scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["acked"]);
  });
});

describe("deposit_confirmed from snapshots", () => {
  it("is emitted once, when a snapshot first lists our deposit as confirmed, with its index and the snapshot", async () => {
    const { events, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 100_000n, [dep(t1, "pending")]) }));
    expect(ofType(events, "deposit_confirmed")).toEqual([]);

    const R2 = makeReq();
    const r2 = await pay(R2);
    const confirmed = { ...snap(1000n, 125_000n, [dep(t1, "confirmed")]), creditZat: "25000" };
    await hook(paid(R2, r2, { session: confirmed }));
    expect(ofType(events, "deposit_confirmed")).toEqual([
      { type: "deposit_confirmed", txid: t1, index: 1, snapshot: confirmed },
    ]);
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf("deposit_confirmed")).toBeLessThan(types.lastIndexOf("paid"));

    const R3 = makeReq();
    const r3 = await pay(R3);
    await hook(paid(R3, r3, { session: snap(1500n, 125_000n, [{ ...dep(t1, "final"), confirmations: 10 }]) }));
    expect(ofType(events, "deposit_confirmed")).toHaveLength(1);
  });

  it("carries the height when the snapshot's confirmations pin it", async () => {
    const { events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    const session = snap(500n, 125_000n, [{ ...dep(t1, "confirmed"), confirmations: 3 }]);
    await hook(paid(R, r1, { transaction: t1, session }));
    expect(ofType(events, "deposit_confirmed")).toEqual([
      { type: "deposit_confirmed", txid: t1, index: 1, height: 998, snapshot: session },
    ]);
  });

  it("is not repeated after the wait for a block already reported it", async () => {
    const { chain, clock, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    const h = track(hook(refused(R, r1, REASON.awaitingConfirmation, snap(0n, 0n, [dep(t1, "pending")]))));
    await flush();
    chain.mine();
    await clock.advance(8_000);
    expect(h.value).toEqual({ recovered: true });

    const retry = await pay(R);
    await hook(paid(R, retry, { transaction: t1, session: snap(500n, 125_000n, [dep(t1, "confirmed")]) }));
    expect(ofType(events, "deposit_confirmed")).toHaveLength(1);
  });
});

const REJECTIONS = [
  REASON.depositNotToMerchant,
  REASON.depositMemoMismatch,
  REASON.depositTransparent,
  REASON.depositOtherSession,
];

describe("halt after a deposit rejection", () => {
  it.each(REJECTIONS)("after %s the next payload rejects, naming code and txid, without paying", async (code) => {
    const { wallet, clock, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await expect(hook(refused(R, r1, code, snap()))).resolves.toBeUndefined();
    const seen = events.length;

    const next = pay(makeReq());
    await expect(next).rejects.toThrow(code);
    await expect(next).rejects.toThrow(t1);
    expect(wallet.sent).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
    expect(events).toHaveLength(seen);
  });

  it("a call queued on the lock does not make the deposit that was due", async () => {
    const { wallet, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    const queued = pay(makeReq());
    queued.catch(() => {});

    await hook(refused(R1, r1, REASON.depositNotToMerchant, snap(0n, 60_500n)));
    await expect(queued).rejects.toThrow(REASON.depositNotToMerchant);
    await flush();
    expect(wallet.sent).toHaveLength(1);
  });

  it("a refusal without a presented txid still halts", async () => {
    const { hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    await hook(paid(R1, r1, { transaction: voucher(r1).depositTxid as string, session: snap(500n, 125_000n) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    expect(voucher(r2).depositTxid).toBeUndefined();
    await hook(refused(R2, r2, REASON.depositOtherSession, snap(500n, 125_000n)));
    await expect(pay(makeReq())).rejects.toThrow("(none presented)");
  });

  it("other sessions are unaffected", async () => {
    const { wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    await hook(refused(R, r1, REASON.depositMemoMismatch, snap()));
    await expect(pay(makeReq())).rejects.toThrow(REASON.depositMemoMismatch);

    const other = "uregtest1" + "p".repeat(60);
    const r = await pay(makeReq({ payTo: other }));
    expect(voucher(r).depositTxid).toBeDefined();
    expect(wallet.sent.map((d) => d.to)).toEqual([PAY_TO, other]);
  });
});

describe("halt after an unknown deposit status", () => {
  const MEMO_1 = depositMemo(SESSION_KEY, 1);

  it("the next payload rejects, naming the code and no txid, without paying or calling the wallet again", async () => {
    const gated = new GatedWallet(new MockWallet(new FakeChain()));
    gated.inner.failNextWith(new DepositStatusUnknownError(MEMO_1));
    const { clock, events, scheme, pay } = setup({ wallet: gated });

    await expect(pay(makeReq())).rejects.toBeInstanceOf(DepositStatusUnknownError);
    expect(ofType(events, "fatal")).toHaveLength(1);
    expect(ofType(events, "fatal")[0]!.code).toBe("deposit_status_unknown");
    const seen = events.length;

    const next = pay(makeReq());
    await expect(next).rejects.toThrow("deposit_status_unknown");
    await expect(next).rejects.toThrow("(unknown)");
    expect(gated.calls).toBe(1);
    expect(gated.inner.sent).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
    expect(events).toHaveLength(seen);
    expect(scheme.session(PAY_TO)?.deposits).toEqual([{ index: 1, memo: MEMO_1, state: "uncertain" }]);
    expect(scheme.session(PAY_TO)?.depositsMade).toBe(0);
  });

  it("a later deposit that comes back unknown halts a session that had paid before", async () => {
    const { wallet, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    await hook(paid(R1, r1, { transaction: voucher(r1).depositTxid as string, session: snap(500n, 500n) }));
    wallet.failNextWith(new DepositStatusUnknownError(depositMemo(SESSION_KEY, 2)));

    await expect(pay(makeReq())).rejects.toBeInstanceOf(DepositStatusUnknownError);
    await expect(pay(makeReq())).rejects.toThrow("deposit_status_unknown");
    expect(wallet.sent).toHaveLength(1);
  });

  it("other sessions are unaffected", async () => {
    const { wallet, pay } = setup();
    wallet.failNextWith(new DepositStatusUnknownError(MEMO_1));
    await expect(pay(makeReq())).rejects.toBeInstanceOf(DepositStatusUnknownError);

    const other = "uregtest1" + "p".repeat(60);
    const r = await pay(makeReq({ payTo: other }));
    expect(voucher(r).depositTxid).toBeDefined();
    expect(wallet.sent.map((d) => d.to)).toEqual([other]);
  });

  it("a background deposit that comes back unknown halts the session too", async () => {
    const { wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    wallet.failNextWith(new DepositStatusUnknownError(depositMemo(SESSION_KEY, 2)));

    await hook(paid(R, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "confirmed")]) }));
    await flush();

    expect(ofType(events, "deposit_failed")).toHaveLength(1);
    await expect(pay(makeReq())).rejects.toThrow("deposit_status_unknown");
    expect(wallet.sent).toHaveLength(1);
  });
});

describe("ambiguous outcomes and background deposits", () => {
  it("ambiguous outcome advances cumulative", async () => {
    const { events, hook, pay } = setup();
    const R1 = makeReq();
    const r1 = await pay(R1);
    await hook(paid(R1, r1, { session: snap(1000n, 125_000n) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    expect(voucher(r2).cumulativeZat).toBe("1500");

    await expect(hook(base(R2, r2))).resolves.toBeUndefined();
    expect(ofType(events, "ambiguous")).toEqual([{ type: "ambiguous", attemptedZat: "1500" }]);
    expect(voucher(await pay(makeReq())).cumulativeZat).toBe("2000");
  });

  it("background deposit fires when headroom < window and nothing pending", async () => {
    const gated = new GatedWallet(new MockWallet(new FakeChain()));
    const { events, hook, pay } = setup({ wallet: gated });
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    expect(gated.inner.sent).toHaveLength(1);

    gated.shut();
    const session = snap(500n, 60_500n, [dep(t1, "confirmed")]);
    await expect(hook(paid(R, r1, { transaction: t1, session }))).resolves.toBeUndefined();
    expect(gated.calls).toBe(2);
    expect(ofType(events, "deposit_started")).toContainEqual({ type: "deposit_started", index: 2, inline: false });
    expect(gated.inner.sent).toHaveLength(1);

    gated.open();
    await flush();
    expect(gated.inner.sent).toHaveLength(2);
    const [, second] = ofType(events, "deposit_broadcast");
    expect(voucher(await pay(makeReq())).depositTxid).toBe(second?.txid);
  });

  it("no background deposit while the snapshot lists a pending one", async () => {
    const { wallet, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    await hook(paid(R, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "pending")]) }));
    await flush();
    expect(wallet.sent).toHaveLength(1);
  });

  it("a failed background deposit is reported and retried only by a later trigger", async () => {
    const { wallet, events, hook, pay } = setup();
    const R = makeReq();
    const r1 = await pay(R);
    const t1 = voucher(r1).depositTxid as string;
    wallet.failNextWith(new Error("busy"));
    await hook(paid(R, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "confirmed")]) }));
    await flush();
    expect(ofType(events, "deposit_failed")).toEqual([{ type: "deposit_failed", index: 2, error: new Error("busy") }]);
    expect(wallet.sent).toHaveLength(1);

    await pay(makeReq());
    await flush();
    expect(wallet.sent.map((s) => s.memo)).toEqual([depositMemo(SESSION_KEY, 1), depositMemo(SESSION_KEY, 3)]);
  });

  it("single flight: two triggers in a row produce exactly one sendDeposit", async () => {
    const gated = new GatedWallet(new MockWallet(new FakeChain()));
    const { hook, pay } = setup({ wallet: gated });
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;

    gated.shut();
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "confirmed")]) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    await hook(paid(R2, r2, { session: snap(1000n, 60_500n, [dep(t1, "confirmed")]) }));
    expect(gated.calls).toBe(2);

    gated.open();
    await flush();
    expect(gated.inner.sent).toHaveLength(2);
  });

  it("an inline trigger joins the in-flight background deposit and attaches its txid", async () => {
    const gated = new GatedWallet(new MockWallet(new FakeChain()));
    const { events, hook, pay } = setup({ wallet: gated });
    const R1 = makeReq();
    const r1 = await pay(R1);
    const t1 = voucher(r1).depositTxid as string;

    gated.shut();
    await hook(paid(R1, r1, { transaction: t1, session: snap(500n, 60_500n, [dep(t1, "confirmed")]) }));
    const R2 = makeReq();
    const r2 = await pay(R2);
    await expect(
      hook(refused(R2, r2, REASON.cumulativeMismatch, snap(60_300n, 60_500n, [dep(t1, "confirmed")]))),
    ).resolves.toEqual({ recovered: true });

    const retry = track(pay(R2));
    await flush();
    expect(retry.done).toBe(false);
    gated.open();
    await flush();
    expect(retry.done).toBe(true);
    expect(gated.calls).toBe(2);
    const [, second] = ofType(events, "deposit_broadcast");
    expect(voucher(retry.value as PaymentPayloadResult).depositTxid).toBe(second?.txid);
    expect(voucher(retry.value as PaymentPayloadResult).cumulativeZat).toBe("60800");
  });
});

describe("uncertain deposits", () => {
  it("an uncertain deposit is promoted when it appears", async () => {
    const chain = new FakeChain();
    const inner = chain.statusSource();
    const checks: string[] = [];
    const source: TxStatusSource = {
      tip: () => inner.tip(),
      status: (txid) => {
        checks.push(txid);
        return inner.status(txid);
      },
    };
    const { scheme, wallet, clock, events, hook, pay } = setup({ chain, source });
    const T = chain.broadcast({ outputs: [{ to: PAY_TO, valueZat: WINDOW, memo: depositMemo(SESSION_KEY, 1) }] });
    chain.hold(T);
    wallet.failNextWith(new DepositUncertainError(T));
    const checksOfT = () => checks.filter((c) => c === T).length;

    await expect(pay(makeReq())).rejects.toBeInstanceOf(DepositUncertainError);
    expect(scheme.session(PAY_TO)?.deposits).toEqual([
      { index: 1, memo: depositMemo(SESSION_KEY, 1), txid: T, state: "uncertain" },
    ]);
    expect(scheme.session(PAY_TO)?.depositsMade).toBe(0);
    expect(ofType(events, "deposit_failed")).toHaveLength(1);

    const R2 = makeReq();
    const r2 = await pay(R2);
    expect(voucher(r2).depositTxid).toBeUndefined();
    await expect(hook(refused(R2, r2, REASON.depositRequired, snap()))).resolves.toEqual({ recovered: true });
    expect(wallet.sent.map((s) => s.memo)).toEqual([depositMemo(SESSION_KEY, 2)]);
    const r3 = await pay(R2);
    const t2 = voucher(r3).depositTxid as string;
    expect(t2).toBeDefined();
    expect(t2).not.toBe(T);
    await hook(paid(R2, r3, { transaction: t2, session: snap(500n, 100_000n, [dep(t2, "pending")]) }));

    chain.unhold(T);
    chain.mine();
    await clock.advance(5_000);
    const R4 = makeReq();
    const r4 = await pay(R4);
    expect(voucher(r4).depositTxid).toBeUndefined();
    expect(checksOfT()).toBe(0);
    await hook(paid(R4, r4, { session: snap(1000n, 125_000n, [dep(t2, "confirmed")]) }));

    await clock.advance(5_000);
    const R5 = makeReq();
    const r5 = await pay(R5);
    expect(voucher(r5).depositTxid).toBe(T);
    expect(checksOfT()).toBe(1);
    expect(scheme.session(PAY_TO)?.deposits.find((d) => d.txid === T)?.state).toBe("sent");
    await hook(paid(R5, r5, { transaction: T, session: snap(1500n, 225_000n) }));

    await clock.advance(10_000);
    await pay(makeReq());
    expect(checksOfT()).toBe(1);
  });

  it("an unseen uncertain deposit is checked at most once per 10 s, dead after a 120 s, 2-block streak", async () => {
    const chain = new FakeChain();
    const inner = chain.statusSource();
    const T = "cd".repeat(32);
    let checks = 0;
    const source: TxStatusSource = {
      tip: () => inner.tip(),
      status: (txid) => {
        if (txid === T) checks += 1;
        return inner.status(txid);
      },
    };
    const { scheme, wallet, clock, events, hook, pay } = setup({ chain, source });
    wallet.failNextWith(new DepositUncertainError(T));
    await expect(pay(makeReq())).rejects.toBeInstanceOf(DepositUncertainError);
    const call = async (): Promise<PaymentPayloadResult> => {
      const R = makeReq();
      const r = await pay(R);
      await hook(paid(R, r));
      return r;
    };

    await clock.advance(10_000);
    await call();
    await call();
    expect(checks).toBe(1);
    await clock.advance(9_999);
    await call();
    expect(checks).toBe(1);

    for (let t = 20_000; t <= 120_000; t += 10_000) {
      await clock.advance(t === 20_000 ? 1 : 10_000);
      if (t === 20_000 || t === 30_000) chain.mine();
      expect(voucher(await call()).depositTxid).toBeUndefined();
    }
    expect(checks).toBe(12);
    expect(wallet.sent).toHaveLength(0);
    expect(scheme.session(PAY_TO)?.deposits[0]?.state).toBe("uncertain");

    await clock.advance(10_000);
    const r = await pay(makeReq());
    expect(ofType(events, "deposit_dead")).toEqual([{ type: "deposit_dead", txid: T }]);
    expect(wallet.sent.map((s) => s.memo)).toEqual([depositMemo(SESSION_KEY, 2)]);
    expect(voucher(r).depositTxid).toBeDefined();
  });
});

describe("session view and close", () => {
  it("session(payTo) is a read-only copy of the session state", async () => {
    const { scheme, hook, pay } = setup();
    expect(scheme.session(PAY_TO)).toBeUndefined();
    const R = makeReq();
    const r = await pay(R);
    await hook(paid(R, r, { session: snap(500n, 125_000n) }));
    const view = scheme.session(PAY_TO);
    expect(view).toMatchObject({
      network: NETWORK_REGTEST,
      payTo: PAY_TO,
      sessionKey: SESSION_KEY,
      cumulativeZat: 500n,
      depositsMade: 1,
      nextIndex: 2,
    });
    expect(scheme.session(PAY_TO, NETWORK_TESTNET)).toBeUndefined();
    expect(view?.deposits).toHaveLength(1);
    (view?.deposits as unknown[]).length = 0;
    if (view?.snapshot) view.snapshot.cumulativeZat = "999999";
    expect(scheme.session(PAY_TO)?.deposits).toHaveLength(1);
    expect(scheme.session(PAY_TO)?.snapshot?.cumulativeZat).toBe("500");
  });

  it("close() closes the wallet", async () => {
    let closed = 0;
    const chain = new FakeChain();
    const mock = new MockWallet(chain);
    const wallet: ZcashWallet = {
      sendDeposit: (req) => mock.sendDeposit(req),
      close: async () => {
        closed += 1;
      },
    };
    const { scheme, clock, pay } = setup({ wallet, chain });
    await pay(makeReq());
    await scheme.close();
    expect(closed).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });
});
