import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  ASSET,
  ChainUnavailableError,
  DEMO_TERMS,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseSessionSnapshot,
  REASON,
  SCHEME,
  type ChainView,
  type FoundInspection,
  type ReasonCode,
  type SessionSnapshot,
  type ZcashNetwork,
} from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Ledger, LedgerRefusal, type LedgerEvent } from "../src/core/ledger.js";
import { DepositResolver } from "../src/core/resolver.js";
import { commit, FacilitatorState } from "../src/core/state.js";
import { ChainWatcher } from "../src/core/watcher.js";
import { PrepaidVoucherFacilitatorScheme, type SchemeConfig } from "../src/scheme.js";
import { termsVersion } from "../src/termsVersion.js";
import { ScriptedChain } from "./support/scriptedChain.js";
import { OTHER_SEED, OTHER_SESSION_KEY, paymentFor, SESSION_KEY as K, voucherFor } from "./support/vouchers.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const W = 100000n;
const WAIT_MS = 30000;
/** sha256 of ["uregtest1q…q","500",{the demo terms}] taken with shasum, never with the code under test */
const TERMS_VERSION = "23e5935a1b39a198";

const CONFIG: SchemeConfig = {
  network: NETWORK,
  payTo: PAY_TO,
  priceZat: 500n,
  terms: DEMO_TERMS,
  depositWaitMs: WAIT_MS,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The requirements the API sends, carrying the facilitator's terms as the server scheme copies them */
function req(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: NETWORK,
    asset: ASSET,
    amount: "500",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      windowZat: "100000",
      creditRatioBps: 2500,
      creditCapZat: "200000",
      zeroConfMinExpiryBlocks: 20,
      termsVersion: TERMS_VERSION,
    },
    ...over,
  };
}

/** A voucher for cumulative `c`, from session K unless another seed is given */
function pay(c: bigint, o: { txid?: string; seed?: Uint8Array } = {}): PaymentPayload {
  const requirements = req();
  return paymentFor(requirements, voucherFor(requirements, c, { seed: o.seed, depositTxid: o.txid }));
}

/** A fresh session that has paid nothing, one per n */
const throwaway = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + n * 3 + 40) % 256);

/** Time that moves only when a test or a resolver sleep moves it */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (by: number) => {
      ms += by;
    },
    advance: (by: number) => {
      ms += by;
    },
  };
}

/** Fails the test on any reply whose snapshot does not parse or belongs to someone other than the payer */
function checkedReply<T extends VerifyResponse | SettleResponse>(r: T): T {
  if (r.extra === undefined) return r;
  const snapshot = parseSessionSnapshot(r.extra.session);
  if (snapshot === null || snapshot.sessionKey !== r.payer) throw new Error(`bad snapshot in ${JSON.stringify(r)}`);
  return r;
}

/** The scheme under test, with every snapshot it emits validated */
class CheckedScheme extends PrepaidVoucherFacilitatorScheme {
  override async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return checkedReply(await super.verify(payload, requirements));
  }

  override async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return checkedReply(await super.settle(payload, requirements));
  }
}

/** The scheme over a real resolver, watcher, ledger and state that all read `view` */
function wire(view: ChainView, o: { fakeTime?: boolean; config?: Partial<SchemeConfig> } = {}) {
  const clock = fakeClock();
  const fake = o.fakeTime ?? true;
  const ledger = new Ledger();
  const state = new FacilitatorState();
  const write = (events: LedgerEvent[]) => commit(ledger, state, events);
  const quiet = { chain: view, pollMs: 1, log: () => undefined };
  const resolver = new DepositResolver(fake ? { ...quiet, now: clock.now, sleep: clock.sleep } : quiet);
  const watcher = new ChainWatcher({
    chain: view,
    state,
    commit: write,
    log: () => undefined,
    ...(fake ? { now: clock.now } : {}),
  });
  const onFatal = vi.fn<(err: unknown) => void>();
  const log = vi.fn<(msg: string, err?: unknown) => void>();
  const s = new CheckedScheme({
    config: { ...CONFIG, ...o.config },
    state,
    resolver,
    watcher,
    commit: write,
    onFatal,
    log,
  });
  return { view, clock, ledger, state, resolver, watcher, s, onFatal, log };
}

/** A FakeChain behind the scheme, its view optionally wrapped */
function rig(wrap: (view: ChainView) => ChainView = (view) => view, config: Partial<SchemeConfig> = {}) {
  const chain = new FakeChain({ expiryDelta: 40 });
  return { chain, ...wire(wrap(chain.viewFor(PAY_TO)), { config }) };
}

type Rig = ReturnType<typeof rig>;

/** Broadcasts a deposit to the merchant, one window with session K's first memo unless told otherwise */
function send(
  chain: FakeChain,
  o: { valueZat?: bigint; memo?: string | null; to?: string; hasTransparent?: boolean; expiryDelta?: number } = {},
): string {
  return chain.broadcast({
    outputs: [{ to: o.to ?? PAY_TO, valueZat: o.valueZat ?? W, memo: o.memo === undefined ? `${K}:1` : o.memo }],
    hasTransparent: o.hasTransparent,
    expiryDelta: o.expiryDelta,
  });
}

/** Session K's first call, whose deposit d1 is verified at zero-conf and credited by the settle at 500 */
async function opened(r: Rig): Promise<string> {
  const d1 = send(r.chain);
  expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
  expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({ success: true, transaction: d1 });
  return d1;
}

/** The response's extra.session, which must parse as a protocol snapshot */
function sessionOf(r: VerifyResponse | SettleResponse): SessionSnapshot {
  const snapshot = parseSessionSnapshot(r.extra?.session);
  if (snapshot === null) throw new Error(`no valid extra.session in ${JSON.stringify(r)}`);
  return snapshot;
}

const creditedTxids = (ledger: Ledger): string[] =>
  ledger.replay().flatMap((e) => (e.t === "deposit" ? [e.txid] : []));

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets pending callbacks run until `done` holds */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await turn();
  expect(done()).toBe(true);
}

/** The promise's value, or "still waiting" when it has not settled after a few event-loop turns */
async function within<T>(p: Promise<T>): Promise<T | "still waiting"> {
  const later = async () => {
    for (let i = 0; i < 20; i++) await turn();
    return "still waiting" as const;
  };
  return Promise.race([p, later()]);
}

/** A view whose inspect of a closed txid waits until the test opens it */
function gated() {
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  return {
    wrap: (view: ChainView): ChainView => ({
      tip: () => view.tip(),
      inspect: async (txid) => {
        await gates.get(txid)?.opened;
        return view.inspect(txid);
      },
    }),
    close(txid: string): void {
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      gates.set(txid, { opened, open });
    },
    open(txid: string): void {
      gates.get(txid)?.open();
      gates.delete(txid);
    },
  };
}

/** A view whose inspect of the given txids throws a plain Error, as a crashing decoder would */
function crashing(txids: Set<string>) {
  return (view: ChainView): ChainView => ({
    tip: () => view.tip(),
    inspect: async (txid) => {
      if (txids.has(txid)) throw new Error("zdecrypt crashed");
      return view.inspect(txid);
    },
  });
}

/** A mempool inspection of one window for session K, as lightwalletd reports it */
function mempoolDeposit(txid: string, expiryHeight: number): FoundInspection {
  return {
    found: true,
    txid,
    location: "mempool",
    minedHeight: null,
    expiryHeight,
    hasTransparent: false,
    outputs: [{ pool: "ironwood", valueZat: W, memo: `${K}:1` }],
  };
}

describe("requirements and payload checks", () => {
  test.each<[string, Partial<PaymentRequirements>]>([
    ["payTo", { payTo: OTHER_PAY_TO }],
    ["amount", { amount: "1000" }],
    ["asset", { asset: "TAZ" }],
    ["extra.windowZat", { extra: { ...req().extra, windowZat: "1" } }],
    ["extra without a term", { extra: { windowZat: "100000", creditRatioBps: 2500, creditCapZat: "200000" } }],
    ["network", { network: NETWORK_TESTNET }],
    ["scheme", { scheme: "exact" }],
  ])("requirements must equal config, so another %s → invalid_payment_requirements", async (_, over) => {
    const { s } = rig();
    const requirements = req(over);

    expect(await s.verify(pay(500n), requirements)).toStrictEqual({
      isValid: false,
      invalidReason: REASON.invalidPaymentRequirements,
      invalidMessage: expect.any(String),
    });
    expect(await s.settle(pay(500n), requirements)).toStrictEqual({
      success: false,
      errorReason: REASON.invalidPaymentRequirements,
      errorMessage: expect.any(String),
      transaction: "",
      network: requirements.network,
    });
  });

  test("x402Version 1 is refused", async () => {
    const { s } = rig();
    const payload = { ...pay(500n), x402Version: 1 };

    expect(await s.verify(payload, req())).toStrictEqual({
      isValid: false,
      invalidReason: REASON.invalidX402Version,
      invalidMessage: expect.any(String),
    });
    expect(await s.settle(payload, req())).toStrictEqual({
      success: false,
      errorReason: REASON.invalidX402Version,
      errorMessage: expect.any(String),
      transaction: "",
      network: NETWORK,
    });
  });

  test("an accepted entry of another scheme or network → invalid_scheme or invalid_network", async () => {
    const { s } = rig();
    const otherScheme = { ...pay(500n), accepted: req({ scheme: "exact" }) };
    const otherNetwork = { ...pay(500n), accepted: req({ network: NETWORK_TESTNET }) };

    expect(await s.verify(otherScheme, req())).toMatchObject({ isValid: false, invalidReason: REASON.invalidScheme });
    expect(await s.settle(otherScheme, req())).toMatchObject({ success: false, errorReason: REASON.invalidScheme });
    expect(await s.verify(otherNetwork, req())).toMatchObject({ isValid: false, invalidReason: REASON.invalidNetwork });
    expect(await s.settle(otherNetwork, req())).toMatchObject({ success: false, errorReason: REASON.invalidNetwork });
  });

  test.each<[string, (v: Record<string, unknown>) => Record<string, unknown>]>([
    ["uppercase sessionKey", (v) => ({ ...v, sessionKey: K.toUpperCase() })],
    ["cumulativeZat 0500", (v) => ({ ...v, cumulativeZat: "0500" })],
    ["sig 127 hex", (v) => ({ ...v, sig: String(v.sig).slice(1) })],
    ["txid 65 hex", (v) => ({ ...v, depositTxid: "a".repeat(65) })],
  ])("%s → invalid_payload", async (_, mangle) => {
    const { s } = rig();
    const payload = paymentFor(req(), mangle(voucherFor(req(), 500n)));

    expect(await s.verify(payload, req())).toStrictEqual({
      isValid: false,
      invalidReason: REASON.invalidPayload,
      invalidMessage: expect.any(String),
    });
    expect(await s.settle(payload, req())).toMatchObject({ success: false, errorReason: REASON.invalidPayload });
  });

  test("txid spelling variants are rejected", async () => {
    const { chain, view, s } = rig();
    const d1 = send(chain);
    const inspect = vi.spyOn(view, "inspect");

    for (const txid of [d1.toUpperCase(), ` ${d1}`]) {
      expect(await s.verify(pay(500n, { txid }), req())).toMatchObject({
        isValid: false,
        invalidReason: REASON.invalidPayload,
      });
      expect(await s.settle(pay(500n, { txid }), req())).toMatchObject({
        success: false,
        errorReason: REASON.invalidPayload,
      });
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  test("bad signature → z402_invalid_signature without snapshot", async () => {
    const { s } = rig();
    const genuine = voucherFor(req(), 500n);
    const sig = String(genuine.sig);
    const forged = [
      { ...genuine, sig: `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}` },
      { ...voucherFor(req(), 500n, { seed: OTHER_SEED }), sessionKey: K },
      voucherFor(req({ payTo: OTHER_PAY_TO }), 500n),
      { ...genuine, cumulativeZat: "1000" },
    ];

    for (const voucher of forged) {
      const payload = paymentFor(req(), voucher);
      expect(await s.verify(payload, req())).toStrictEqual({
        isValid: false,
        invalidReason: REASON.invalidSignature,
        invalidMessage: expect.any(String),
      });
      expect(await s.settle(payload, req())).toStrictEqual({
        success: false,
        errorReason: REASON.invalidSignature,
        errorMessage: expect.any(String),
        transaction: "",
        network: NETWORK,
      });
    }
  });
});

describe("a session's first calls", () => {
  test("first voucher without deposit → deposit_required, limit 0", async () => {
    const { s } = rig();

    const verdict = await s.verify(pay(500n), req());
    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired, payer: K });
    expect(sessionOf(verdict)).toMatchObject({ sessionKey: K, cumulativeZat: "0", limitZat: "0", deposits: [] });

    const settled = await s.settle(pay(500n), req());
    expect(settled).toMatchObject({
      success: false,
      errorReason: REASON.depositRequired,
      transaction: "",
      network: NETWORK,
      payer: K,
    });
    expect(settled).not.toHaveProperty("amount");
    expect(sessionOf(settled).limitZat).toBe("0");
  });

  test("first voucher with pending deposit is served at zero-conf", async () => {
    const { chain, ledger, resolver, s } = rig();
    const d1 = send(chain);

    expect((await s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    expect(ledger.replay()).toEqual([]);
    const r = await s.settle(pay(500n, { txid: d1 }), req());

    expect(r).toMatchObject({ success: true, transaction: d1, amount: "500", network: NETWORK, payer: K });
    expect(r.extra!.session).toMatchObject({
      pendingZat: "100000",
      limitZat: "100000",
      cumulativeZat: "500",
      tip: 1000,
    });
    expect(resolver.peek(d1)).toBeUndefined();
    expect(sessionOf(r).deposits).toEqual([
      { txid: d1, valueZat: "100000", status: "pending", confirmations: 0, expiryHeight: 1041, zeroConf: true },
    ]);
    expect(ledger.replay()).toEqual([
      {
        t: "deposit",
        txid: d1,
        sessionKey: K,
        valueZat: "100000",
        zeroConf: true,
        expiryHeight: 1041,
        firstSeenTip: 1000,
        status: "pending",
        minedHeight: null,
        confirmations: 0,
      },
      { t: "voucher", sessionKey: K, cumulativeZat: "500" },
    ]);
  });

  test("replayed voucher → cumulative_mismatch at verify and settle", async () => {
    const r = rig();
    const d1 = await opened(r);

    const verdict = await r.s.verify(pay(500n, { txid: d1 }), req());
    const settled = await r.s.settle(pay(500n, { txid: d1 }), req());

    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.cumulativeMismatch, payer: K });
    expect(settled).toMatchObject({ success: false, errorReason: REASON.cumulativeMismatch, transaction: "" });
    expect(sessionOf(verdict).cumulativeZat).toBe("500");
    expect(sessionOf(settled).cumulativeZat).toBe("500");
    expect(r.ledger.replay()).toHaveLength(2);
  });

  test("limit with pending deposit → awaiting_confirmation; after mining + refresh → valid at 125000", async () => {
    const r = rig();
    const d1 = await opened(r);
    expect(await r.s.settle(pay(100000n), req())).toMatchObject({ success: true, amount: "99500", transaction: "" });

    const waiting = await r.s.verify(pay(100500n), req());
    expect(waiting).toMatchObject({ isValid: false, invalidReason: REASON.awaitingConfirmation, payer: K });
    expect(sessionOf(waiting)).toMatchObject({ limitZat: "100000", pendingZat: "100000", headroomZat: "0" });

    r.chain.mine();
    r.clock.advance(5000);
    expect((await r.s.verify(pay(125000n), req())).isValid).toBe(true);
    expect(r.state.deposit(d1)).toMatchObject({ status: "confirmed", confirmations: 1 });

    const paid = await r.s.settle(pay(125000n), req());
    expect(paid).toMatchObject({ success: true, amount: "25000", transaction: "" });
    expect(sessionOf(paid)).toMatchObject({
      confirmedZat: "100000",
      creditZat: "25000",
      limitZat: "125000",
      headroomZat: "0",
    });
    expect(await r.s.verify(pay(125500n), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositRequired,
    });
  });
});

describe("lazy crediting", () => {
  test("lazy crediting: D2 that is not needed does not block verify and is acked once resolved", async () => {
    const gate = gated();
    const r = rig(gate.wrap);
    const d1 = await opened(r);
    const d2 = send(r.chain, { memo: `${K}:2` });
    gate.close(d2);

    expect(await within(r.s.verify(pay(1000n, { txid: d2 }), req()))).toMatchObject({ isValid: true, payer: K });
    expect(r.resolver.inFlight(d2)).toBe(true);
    const first = await r.s.settle(pay(1000n, { txid: d2 }), req());
    expect(first).toMatchObject({ success: true, transaction: "", amount: "500" });
    expect(creditedTxids(r.ledger)).toEqual([d1]);

    gate.open(d2);
    await until(() => !r.resolver.inFlight(d2));
    expect((await r.s.verify(pay(1500n, { txid: d2 }), req())).isValid).toBe(true);
    const second = await r.s.settle(pay(1500n, { txid: d2 }), req());

    expect(second).toMatchObject({ success: true, transaction: d2, amount: "500" });
    expect(sessionOf(second).deposits.map((d) => d.txid)).toEqual([d1, d2]);
    expect(creditedTxids(r.ledger)).toEqual([d1, d2]);
  });

  test("a chain outage does not refuse a voucher that fits without the deposit", async () => {
    const r = rig();
    await opened(r);
    const d2 = send(r.chain, { memo: `${K}:2` });
    r.chain.setUnavailable(true);

    expect((await r.s.verify(pay(1000n, { txid: d2 }), req())).isValid).toBe(true);
    await until(() => !r.resolver.inFlight(d2));
    expect(await r.s.settle(pay(1000n, { txid: d2 }), req())).toMatchObject({ success: true, transaction: "" });
  });
});

describe("deposits", () => {
  test("deposit owned by another session → memo_mismatch, as for any found deposit it cannot use", async () => {
    const r = rig();
    const d1 = await opened(r);

    const verdict = await r.s.verify(pay(500n, { txid: d1, seed: OTHER_SEED }), req());
    expect(verdict).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositMemoMismatch,
      invalidMessage: "the deposit cannot be credited",
      payer: OTHER_SESSION_KEY,
    });
    expect(sessionOf(verdict)).toMatchObject({ sessionKey: OTHER_SESSION_KEY, limitZat: "0", deposits: [] });
    expect(await r.s.settle(pay(500n, { txid: d1, seed: OTHER_SEED }), req())).toMatchObject({
      success: false,
      errorReason: REASON.depositMemoMismatch,
      errorMessage: "the deposit cannot be credited",
      payer: OTHER_SESSION_KEY,
    });
    // The operator still learns why, from the log alone
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining("credited to another session"));

    const own = send(r.chain, { memo: `${OTHER_SESSION_KEY}:1` });
    expect((await r.s.verify(pay(500n, { txid: own, seed: OTHER_SEED }), req())).isValid).toBe(true);
    expect(await r.s.settle(pay(500n, { txid: own, seed: OTHER_SEED }), req())).toMatchObject({ success: true });
    expect(await r.s.verify(pay(1000n, { txid: d1, seed: OTHER_SEED }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositMemoMismatch,
    });
    expect(creditedTxids(r.ledger)).toEqual([d1, own]);
  });

  test("a deposit credited elsewhere, one with another memo and one to another address answer alike", async () => {
    const r = rig();
    const elsewhere = await opened(r);
    const otherMemo = send(r.chain, { memo: `${K}:2` });
    const otherAddress = send(r.chain, { to: OTHER_PAY_TO, memo: `${OTHER_SESSION_KEY}:1` });
    const inspect = vi.spyOn(r.view, "inspect");

    /** What a fresh session sees for a txid, and how many chain reads that took */
    const probe = async (txid: string) => {
      const before = inspect.mock.calls.length;
      const verdict = await r.s.verify(pay(500n, { txid, seed: OTHER_SEED }), req());
      const settled = await r.s.settle(pay(500n, { txid, seed: OTHER_SEED }), req());
      return {
        verify: [verdict.invalidReason, verdict.invalidMessage],
        settle: [settled.errorReason, settled.errorMessage],
        reads: inspect.mock.calls.length - before,
      };
    };
    const alike = { verify: [REASON.depositMemoMismatch, "the deposit cannot be credited"] };

    for (const txid of [elsewhere, otherMemo, otherAddress]) {
      expect(await probe(txid)).toEqual({ ...alike, settle: alike.verify, reads: 1 });
    }
    // Seen again within the cache, none of them costs a read
    for (const txid of [elsewhere, otherMemo, otherAddress]) {
      expect(await probe(txid)).toEqual({ ...alike, settle: alike.verify, reads: 0 });
    }
  });

  test("with the lookups saturated, a credited-elsewhere txid and an uncredited one answer alike", async () => {
    const gate = gated();
    const r = rig(gate.wrap);
    const elsewhere = await opened(r);
    const otherMemo = send(r.chain, { memo: `${K}:2` });
    // Twenty free verifies of txids that never answer hold the 4 slots and the 16 places in the queue
    for (let n = 0; n < 20; n++) {
      const txid = `f${n.toString(16).padStart(63, "0")}`;
      gate.close(txid);
      void r.s.verify(pay(500n, { txid, seed: throwaway(n) }), req());
    }
    await turn();

    const seen = [];
    for (const txid of [elsewhere, otherMemo]) {
      const verdict = await r.s.verify(pay(500n, { txid, seed: OTHER_SEED }), req());
      const settled = await r.s.settle(pay(500n, { txid, seed: OTHER_SEED }), req());
      seen.push([verdict.invalidReason, verdict.invalidMessage, settled.errorReason, settled.errorMessage]);
    }

    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.[0]).toBe(REASON.chainUnavailable);
  });

  test("with the chain unreadable, a credited-elsewhere txid and an uncredited one answer alike", async () => {
    const r = rig();
    const elsewhere = await opened(r);
    const otherMemo = send(r.chain, { memo: `${K}:2` });
    r.chain.setUnavailable(true);

    const seen = [];
    for (const txid of [elsewhere, otherMemo]) {
      const verdict = await r.s.verify(pay(500n, { txid, seed: OTHER_SEED }), req());
      const settled = await r.s.settle(pay(500n, { txid, seed: OTHER_SEED }), req());
      seen.push([verdict.invalidReason, verdict.invalidMessage, settled.errorReason, settled.errorMessage]);
    }

    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.[0]).toBe(REASON.chainUnavailable);
  });

  test("a credited deposit gone from the chain answers like a txid the chain never had", async () => {
    const r = rig();
    const gone = await opened(r);
    r.chain.hold(gone);
    r.chain.mine(41);
    await r.watcher.pollNow();
    expect(r.state.deposit(gone)?.status).toBe("dead");

    const seen = [];
    for (const txid of [gone, "ee".repeat(32)]) {
      const verdict = await r.s.verify(pay(500n, { txid, seed: OTHER_SEED }), req());
      seen.push([verdict.invalidReason, verdict.invalidMessage]);
    }

    expect(seen).toEqual([
      [REASON.depositNotFound, "the chain has no such tx"],
      [REASON.depositNotFound, "the chain has no such tx"],
    ]);
  });

  test("re-presented credited txid is acked, not re-credited", async () => {
    const r = rig();
    const d1 = await opened(r);
    const inspect = vi.spyOn(r.view, "inspect");

    expect((await r.s.verify(pay(1000n, { txid: d1 }), req())).isValid).toBe(true);
    const again = await r.s.settle(pay(1000n, { txid: d1 }), req());

    expect(again).toMatchObject({ success: true, transaction: d1, amount: "500" });
    expect(sessionOf(again)).toMatchObject({
      confirmedZat: "0",
      pendingZat: "100000",
      limitZat: "100000",
      cumulativeZat: "1000",
    });
    expect(creditedTxids(r.ledger)).toEqual([d1]);
    expect(inspect).not.toHaveBeenCalled();
  });

  test("dead txid re-presented → deposit_dead", async () => {
    const r = rig();
    const d1 = await opened(r);
    r.chain.hold(d1);
    r.chain.mine(41);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("dead");

    const verdict = await r.s.verify(pay(1000n, { txid: d1 }), req());
    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.depositDead, payer: K });
    expect(sessionOf(verdict).deposits).toEqual([expect.objectContaining({ txid: d1, status: "dead" })]);
    expect(await r.s.settle(pay(1000n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.depositDead,
      transaction: "",
    });
  });

  test.each<[string, ReasonCode, (chain: FakeChain) => string]>([
    ["a transparent part", REASON.depositTransparent, (chain) => send(chain, { hasTransparent: true })],
    ["no output to payTo", REASON.depositMemoMismatch, (chain) => send(chain, { to: OTHER_PAY_TO })],
    ["another session's memo", REASON.depositMemoMismatch, (chain) => send(chain, { memo: `${OTHER_SESSION_KEY}:1` })],
    ["no memo", REASON.depositMemoMismatch, (chain) => send(chain, { memo: null })],
  ])("a found deposit with %s → the evaluation's code", async (_, code, make) => {
    const r = rig();
    const txid = make(r.chain);

    const verdict = await r.s.verify(pay(500n, { txid }), req());
    expect(verdict).toMatchObject({ isValid: false, invalidReason: code, payer: K });
    expect(sessionOf(verdict).deposits).toEqual([]);
    expect(await r.s.settle(pay(500n, { txid }), req())).toMatchObject({ success: false, errorReason: code });
    expect(r.ledger.replay()).toEqual([]);
  });

  test("a deposit lightwalletd still shows in the mempool past its expiry → deposit_dead", async () => {
    const txid = "dd".repeat(32);
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (asked) => (asked === txid ? mempoolDeposit(txid, 1000) : view.inspect(asked)),
    }));

    expect(await r.s.verify(pay(500n, { txid }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositDead,
    });
    expect(await r.s.settle(pay(500n, { txid }), req())).toMatchObject({
      success: false,
      errorReason: REASON.depositDead,
    });
  });

  test("a txid the chain never saw → deposit_not_found at verify and settle", async () => {
    const r = rig();
    const txid = "ee".repeat(32);

    expect(await r.s.verify(pay(500n, { txid }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositNotFound,
      payer: K,
    });
    expect(await r.s.settle(pay(500n, { txid }), req())).toMatchObject({
      success: false,
      errorReason: REASON.depositNotFound,
    });
  });

  test("chain unavailable during a needed lookup → chain_unavailable", async () => {
    const r = rig();
    const d1 = send(r.chain);
    r.chain.setUnavailable(true);

    const verdict = await r.s.verify(pay(500n, { txid: d1 }), req());
    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.chainUnavailable, payer: K });
    expect(sessionOf(verdict).limitZat).toBe("0");
    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
    });

    r.chain.setUnavailable(false);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
  });

  test("slow chain still answers within budget", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 4000;
    const seen = "aa".repeat(32);
    chain.script(seen, [mempoolDeposit(seen, 1041)]);
    const { s } = wire(chain, { fakeTime: false });

    const answers: Array<VerifyResponse | undefined> = [];
    for (const txid of ["bb".repeat(32), seen]) {
      let answer: VerifyResponse | undefined;
      void s.verify(pay(500n, { txid }), req()).then((x) => {
        answer = x;
      });
      await vi.advanceTimersByTimeAsync(WAIT_MS + 5000);
      answers.push(answer);
    }

    expect(answers).toMatchObject([{ isValid: false, invalidReason: REASON.depositNotFound }, { isValid: true }]);
  });

  type Deposit = { valueZat?: bigint; expiryDelta?: number };
  type Want = { valueZat: string; expiryHeight: number; limitZat: string };
  test.each<[string, Deposit, Want]>([
    ["sub-window", { valueZat: 50000n }, { valueZat: "50000", expiryHeight: 1041, limitZat: "62500" }],
    ["short-expiry", { expiryDelta: 10 }, { valueZat: "100000", expiryHeight: 1011, limitZat: "125000" }],
  ])("sub-window and short-expiry deposits wait for confirmation (%s)", async (_, deposit, want) => {
    const r = rig();
    const d1 = send(r.chain, deposit);

    const waiting = await r.s.verify(pay(500n, { txid: d1 }), req());
    expect(waiting).toMatchObject({ isValid: false, invalidReason: REASON.awaitingConfirmation, payer: K });
    expect(sessionOf(waiting)).toMatchObject({
      limitZat: "0",
      deposits: [
        {
          txid: d1,
          valueZat: want.valueZat,
          status: "pending",
          confirmations: 0,
          expiryHeight: want.expiryHeight,
          zeroConf: false,
        },
      ],
    });
    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.awaitingConfirmation,
    });
    expect(r.ledger.replay()).toEqual([]);

    r.chain.mine();
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    const paid = await r.s.settle(pay(500n, { txid: d1 }), req());

    expect(paid).toMatchObject({ success: true, transaction: d1 });
    expect(sessionOf(paid)).toMatchObject({ confirmedZat: want.valueZat, pendingZat: "0", limitZat: want.limitZat });
  });

  test("a credited sub-window deposit is waited for, then counts after mining + refresh", async () => {
    const r = rig();
    await opened(r);
    r.chain.mine();
    await r.watcher.pollNow();
    const d2 = send(r.chain, { valueZat: 50000n, memo: `${K}:2` });
    expect((await r.s.verify(pay(1000n, { txid: d2 }), req())).isValid).toBe(true);
    await until(() => r.resolver.peek(d2) !== undefined);
    expect(await r.s.settle(pay(1000n, { txid: d2 }), req())).toMatchObject({ success: true, transaction: d2 });
    expect(await r.s.settle(pay(125000n), req())).toMatchObject({ success: true });

    expect(await r.s.verify(pay(125500n), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.awaitingConfirmation,
    });

    r.chain.mine();
    r.clock.advance(5000);
    const counted = await r.s.verify(pay(125500n), req());
    expect(counted.isValid).toBe(true);
    expect(sessionOf(counted)).toMatchObject({ confirmedZat: "150000", creditZat: "37500", limitZat: "187500" });
  });
});

describe("stale lookup results", () => {
  /** Session K at its 125000 limit on a confirmed D1, then a verify that needs D2 and finds it pending, expiry 1042 */
  async function needingD2(r: Rig): Promise<string> {
    await opened(r);
    r.chain.mine();
    await r.watcher.pollNow();
    expect(await r.s.settle(pay(125000n), req())).toMatchObject({ success: true });
    const d2 = send(r.chain, { memo: `${K}:2` });
    expect((await r.s.verify(pay(125500n, { txid: d2 }), req())).isValid).toBe(true);
    expect(r.resolver.peek(d2)).toMatchObject({ kind: "found", tip: 1001, inspection: { expiryHeight: 1042 } });
    return d2;
  }

  test("a cached deposit that died since is never credited, and verify reads it once to call it dead", async () => {
    const r = rig();
    const d2 = await needingD2(r);
    r.chain.hold(d2);
    r.chain.mine(41);
    await r.watcher.pollNow();
    const inspect = vi.spyOn(r.view, "inspect");

    const settled = await r.s.settle(pay(125500n, { txid: d2 }), req());
    expect(settled).toMatchObject({ success: false, errorReason: REASON.chainUnavailable, transaction: "" });
    expect(sessionOf(settled).limitZat).toBe("125000");
    expect(inspect).not.toHaveBeenCalled();
    const verdict = await r.s.verify(pay(125500n, { txid: d2 }), req());
    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.depositDead });
    expect(inspect).toHaveBeenCalledTimes(1);

    expect(creditedTxids(r.ledger)).not.toContain(d2);
  });

  test("a found result older than 30 s is not evidence, so settle answers chain_unavailable", async () => {
    const r = rig();
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    r.clock.advance(30_001);

    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
      transaction: "",
    });
    expect(r.ledger.replay()).toEqual([]);

    const inspect = vi.spyOn(r.view, "inspect");
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});

describe("a cached unmined deposit once the tip reaches its expiry", () => {
  /** K's over-limit call at tip 1039 caches d pending and not zero-conf, with expiry 1041 */
  async function cachedNearExpiry(r: Rig): Promise<string> {
    const d = send(r.chain);
    r.chain.hold(d);
    r.chain.mine(39);
    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({
      invalidReason: REASON.awaitingConfirmation,
    });
    expect(r.resolver.peek(d)).toMatchObject({
      kind: "found",
      tip: 1039,
      inspection: { location: "mempool", expiryHeight: 1041 },
    });
    return d;
  }

  test.each([
    ["one block before its expiry", 0],
    ["in its expiry block", 1],
  ])("is read again before any answer, so a deposit mined %s counts", async (_, heldBlocks) => {
    const r = rig();
    const d = await cachedNearExpiry(r);
    r.chain.mine(heldBlocks);
    r.chain.unhold(d);
    r.chain.mine(1);
    r.chain.mine(1 - heldBlocks);
    await r.watcher.pollNow();
    expect(r.watcher.lastTip()).toBe(1041);
    const inspect = vi.spyOn(r.view, "inspect");

    expect((await r.s.verify(pay(500n, { txid: d }), req())).isValid).toBe(true);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(await r.s.settle(pay(500n, { txid: d }), req())).toMatchObject({ success: true, transaction: d });
  });

  test("settle never calls it dead from the cache alone, it answers chain_unavailable", async () => {
    const r = rig();
    const d = await cachedNearExpiry(r);
    r.chain.mine(2);
    await r.watcher.pollNow();

    expect(await r.s.settle(pay(500n, { txid: d }), req())).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
    });
    expect(r.ledger.replay()).toEqual([]);
  });

  test("a fresh read that finds it gone past its expiry calls it dead", async () => {
    const r = rig();
    const d = await cachedNearExpiry(r);
    r.chain.mine(2);
    await r.watcher.pollNow();

    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({ invalidReason: REASON.depositDead });
  });

  test("a fresh read that sees it unmined at a tip past its expiry calls it dead", async () => {
    let d = "";
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (txid) => (txid === d && r.chain.height >= 1041 ? mempoolDeposit(txid, 1041) : view.inspect(txid)),
    }));
    d = await cachedNearExpiry(r);
    r.chain.mine(2);
    await r.watcher.pollNow();

    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({ invalidReason: REASON.depositDead });
  });

  test("a fresh read that finds it gone is dead only once a tip read before that read reached the expiry", async () => {
    let lagging = false;
    const r = rig((view) => ({
      // The read is answered by a backend two blocks behind the one the watcher asked
      tip: async () => (lagging ? (await view.tip()) - 2 : view.tip()),
      inspect: (txid) => view.inspect(txid),
    }));
    const d = await cachedNearExpiry(r);
    r.chain.mine(2);
    await r.watcher.pollNow();
    expect(r.watcher.lastTip()).toBe(1041);
    lagging = true;

    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositNotFound,
    });
  });

  test("a fresh read that fails answers chain_unavailable, never dead", async () => {
    const r = rig();
    const d = await cachedNearExpiry(r);
    r.chain.mine(2);
    await r.watcher.pollNow();
    r.chain.setUnavailable(true);

    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.chainUnavailable,
    });
  });
});

describe("a deposit mined in its expiry block just after a read saw it in the mempool", () => {
  test("counts, since the read took the tip before the inspect", async () => {
    let d = "";
    let mineAfterInspect = false;
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (txid) => {
        const answer = await view.inspect(txid);
        // Block 1041, the deposit's expiry, arrives with it right after this inspect saw it unmined
        if (txid === d && mineAfterInspect) {
          mineAfterInspect = false;
          r.chain.mine(1);
        }
        return answer;
      },
    }));
    d = send(r.chain);
    r.chain.hold(d);
    r.chain.mine(40);
    r.chain.unhold(d);
    mineAfterInspect = true;

    expect(await r.s.verify(pay(500n, { txid: d }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.awaitingConfirmation,
    });
    expect(r.chain.height).toBe(1041);
    expect((await r.s.verify(pay(500n, { txid: d }), req())).isValid).toBe(true);
    expect(await r.s.settle(pay(500n, { txid: d }), req())).toMatchObject({ success: true, transaction: d });
  });
});

describe("a credited pending deposit past its expiry while its lookups fail", () => {
  test("stops counting at the current tip, writes nothing, and counts again once it reads mined", async () => {
    let d1 = "";
    let answer: "chain" | "outage" | { minedAt: number } = "chain";
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (txid) => {
        if (txid !== d1 || answer === "chain") return view.inspect(txid);
        if (answer === "outage") throw new ChainUnavailableError("lightwalletd is unreachable");
        return { ...mempoolDeposit(txid, 1041), location: "mined", minedHeight: answer.minedAt };
      },
    }));
    d1 = await opened(r);
    answer = "outage";
    r.chain.hold(d1);
    r.chain.mine(41);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("pending");

    const over = await r.s.verify(pay(100500n), req());
    expect(over).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired });
    // Left out of the limit, and listed as the pending the watcher last recorded (R49)
    expect(sessionOf(over)).toMatchObject({
      limitZat: "0",
      deposits: [expect.objectContaining({ txid: d1, status: "pending" })],
    });
    expect(await r.s.settle(pay(1000n), req())).toMatchObject({ success: false, errorReason: REASON.depositRequired });
    expect(await r.s.verify(pay(1000n, { txid: d1 }), req())).toMatchObject({ invalidReason: REASON.chainUnavailable });
    expect(r.ledger.replay().map((e) => e.t)).toEqual(["deposit", "voucher"]);

    answer = { minedAt: 1040 };
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)).toMatchObject({ status: "confirmed", minedHeight: 1040, confirmations: 2 });
    const counted = await r.s.verify(pay(1000n), req());
    expect(counted.isValid).toBe(true);
    expect(sessionOf(counted)).toMatchObject({ confirmedZat: "100000", limitZat: "125000" });
  });

  test("is left out of the limit of a settle that succeeds on another, and listed as last recorded", async () => {
    let d1 = "";
    let failing = false;
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (txid) => {
        if (txid === d1 && failing) throw new ChainUnavailableError("lightwalletd is unreachable");
        return view.inspect(txid);
      },
    }));
    d1 = await opened(r);
    r.chain.hold(d1);
    const d2 = send(r.chain, { memo: `${K}:2` });
    r.chain.mine();
    await r.s.verify(pay(1000n, { txid: d2 }), req());
    await until(() => r.resolver.peek(d2) !== undefined);
    expect(await r.s.settle(pay(1000n, { txid: d2 }), req())).toMatchObject({ success: true, transaction: d2 });
    failing = true;
    r.chain.mine(40);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("pending");
    expect(r.state.deposit(d2)?.status).toBe("final");

    const settled = await r.s.settle(pay(1500n), req());
    expect(settled).toMatchObject({ success: true });
    const snapshot = sessionOf(settled);
    expect(snapshot.limitZat).toBe("125000");
    expect(snapshot.deposits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ txid: d1, status: "pending" }),
        expect.objectContaining({ txid: d2, status: "final" }),
      ]),
    );
    expect(r.state.deposit(d1)?.status).toBe("pending");
  });
});

describe("a presented own deposit past its expiry, which only a fresh read may call dead (R49)", () => {
  type Answer = "outage" | "gone" | "unmined" | { minedAt: number };

  /** K's d1, credited at zero-conf, whose reads fail while the tip reaches its expiry of 1041 */
  async function pastExpiry() {
    let d1 = "";
    const control: { answer: Answer; reads: number } = { answer: "outage", reads: 0 };
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async (txid) => {
        if (txid !== d1) return view.inspect(txid);
        control.reads++;
        const a = control.answer;
        if (a === "outage") throw new ChainUnavailableError("lightwalletd is unreachable");
        if (a === "gone") return { found: false };
        if (a === "unmined") return mempoolDeposit(txid, 1041);
        return { ...mempoolDeposit(txid, 1041), location: "mined", minedHeight: a.minedAt };
      },
    }));
    d1 = await opened(r);
    r.chain.hold(d1);
    r.chain.mine(41);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("pending");
    return { r, d1, control };
  }

  test("is chain_unavailable while its reads fail, counts nowhere, and nothing is written", async () => {
    const { r, d1, control } = await pastExpiry();
    const before = control.reads;

    const verified = await r.s.verify(pay(1000n, { txid: d1 }), req());
    expect(verified).toMatchObject({ isValid: false, invalidReason: REASON.chainUnavailable });
    expect(control.reads).toBe(before + 1);
    expect(sessionOf(verified)).toMatchObject({ limitZat: "0", pendingZat: "0" });
    expect(await r.s.settle(pay(1000n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
    });
    expect(r.ledger.replay().map((e) => e.t)).toEqual(["deposit", "voucher"]);
    expect(r.state.deposit(d1)?.status).toBe("pending");
  });

  test("is chain_unavailable, never dead, when the refresh it needs is not due yet", async () => {
    const { r, d1, control } = await pastExpiry();
    expect(await r.s.verify(pay(1000n, { txid: d1 }), req())).toMatchObject({
      invalidReason: REASON.chainUnavailable,
    });
    control.answer = "gone";
    const before = control.reads;

    expect(await r.s.verify(pay(1000n, { txid: d1 }), req())).toMatchObject({
      invalidReason: REASON.chainUnavailable,
    });
    expect(control.reads).toBe(before);
    r.clock.advance(5000);
    expect(await r.s.verify(pay(1000n, { txid: d1 }), req())).toMatchObject({ invalidReason: REASON.depositDead });
  });

  test.each([
    ["one block before its expiry", 1040, 2],
    ["in its expiry block", 1041, 1],
  ])("counts and is credited once a read shows it mined %s", async (_, minedHeight, confirmations) => {
    const { r, d1, control } = await pastExpiry();
    control.answer = { minedAt: minedHeight };

    const verified = await r.s.verify(pay(1000n, { txid: d1 }), req());
    expect(verified.isValid).toBe(true);
    expect(sessionOf(verified)).toMatchObject({ confirmedZat: "100000", limitZat: "125000" });
    expect(r.state.deposit(d1)).toMatchObject({ status: "confirmed", minedHeight, confirmations });
    expect(await r.s.settle(pay(1000n, { txid: d1 }), req())).toMatchObject({ success: true, transaction: d1 });
  });

  test("is listed as the pending last recorded, so no snapshot reports a death no read has shown", async () => {
    const { r, d1 } = await pastExpiry();
    const listing = expect.objectContaining({ txid: d1, status: "pending", confirmations: 0 });

    const over = await r.s.verify(pay(100500n), req());
    expect(over).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired });
    expect(sessionOf(over)).toMatchObject({ limitZat: "0", pendingZat: "0", deposits: [listing] });
    const presented = await r.s.verify(pay(1000n, { txid: d1 }), req());
    expect(presented).toMatchObject({ invalidReason: REASON.chainUnavailable });
    expect(sessionOf(presented)).toMatchObject({ limitZat: "0", pendingZat: "0", deposits: [listing] });
  });

  test.each<[string, Answer]>([
    ["gone", "gone"],
    ["still unmined at a tip at its expiry", "unmined"],
  ])("is dead once a read finds it %s, and that read is recorded", async (_, answer) => {
    const { r, d1, control } = await pastExpiry();
    control.answer = answer;

    expect(await r.s.verify(pay(1000n, { txid: d1 }), req())).toMatchObject({ invalidReason: REASON.depositDead });
    expect(r.ledger.replay().at(-1)).toMatchObject({ t: "status", txid: d1, status: "dead", deadAtTip: 1041 });
    expect(await r.s.settle(pay(1000n, { txid: d1 }), req())).toMatchObject({ errorReason: REASON.depositDead });
  });
});

describe("the refresh before a refusal", () => {
  test("waits at most refreshWaitMs, even behind a watcher pass that is held up", async () => {
    const gate = gated();
    const r = rig(gate.wrap, { refreshWaitMs: 50 });
    await opened(r);
    const theirs = send(r.chain, { memo: `${OTHER_SESSION_KEY}:1` });
    expect((await r.s.verify(pay(500n, { txid: theirs, seed: OTHER_SEED }), req())).isValid).toBe(true);
    expect(await r.s.settle(pay(500n, { txid: theirs, seed: OTHER_SEED }), req())).toMatchObject({ success: true });
    gate.close(theirs);
    const pass = r.watcher.pollNow();
    const refresh = vi.spyOn(r.watcher, "refreshSession");

    const slow = new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1000));
    const answer = await Promise.race([r.s.verify(pay(100500n), req()), slow]);

    expect(answer).toMatchObject({ isValid: false, invalidReason: REASON.awaitingConfirmation, payer: K });
    expect(refresh).toHaveBeenCalledTimes(1);
    gate.open(theirs);
    await pass;
  });

  test("is skipped when the session's only presented deposit is still being looked up", async () => {
    const r = rig();
    const txid = "ee".repeat(32);
    const refresh = vi.spyOn(r.watcher, "refreshSession");
    // A second lookup of the same txid starts the moment the first one ends, as a concurrent verify would start it
    const first = r.resolver.lookup(txid, 0);
    void first.then(() => r.resolver.startBackground(txid, WAIT_MS));

    const verdict = await r.s.verify(pay(500n, { txid }), req());

    expect(refresh).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ isValid: false, invalidReason: REASON.awaitingConfirmation });
  });

  test("is skipped when the only pending deposit is the presented one, which is not credited yet", async () => {
    const r = rig();
    const short = send(r.chain, { expiryDelta: 10 });
    const refresh = vi.spyOn(r.watcher, "refreshSession");

    expect(await r.s.verify(pay(500n, { txid: short }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.awaitingConfirmation,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  test("still runs for a credited pending deposit, which a block can confirm", async () => {
    const r = rig();
    await opened(r);
    const refresh = vi.spyOn(r.watcher, "refreshSession");
    r.chain.mine();

    expect((await r.s.verify(pay(100500n), req())).isValid).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a cached definitive failure", () => {
  test("is answered again by an over-limit verify with no new inspect", async () => {
    const r = rig();
    const txid = send(r.chain, { memo: `${OTHER_SESSION_KEY}:1` });
    expect(await r.s.verify(pay(500n, { txid }), req())).toMatchObject({ invalidReason: REASON.depositMemoMismatch });
    const inspect = vi.spyOn(r.view, "inspect");

    expect(await r.s.verify(pay(500n, { txid }), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositMemoMismatch,
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  test("lets a voucher that fits pass with no background lookup, and settle does not ack it", async () => {
    const r = rig();
    await opened(r);
    const txid = send(r.chain, { memo: `${OTHER_SESSION_KEY}:1` });
    expect((await r.s.verify(pay(1000n, { txid }), req())).isValid).toBe(true);
    await until(() => r.resolver.peek(txid) !== undefined);
    const background = vi.spyOn(r.resolver, "startBackground");

    expect((await r.s.verify(pay(1000n, { txid }), req())).isValid).toBe(true);
    expect(background).not.toHaveBeenCalled();
    expect(await r.s.settle(pay(1000n, { txid }), req())).toMatchObject({ success: true, transaction: "" });
    expect(creditedTxids(r.ledger)).not.toContain(txid);
  });

  test("a credited deposit that is orphaned is not live, so an over-limit verify asks for a deposit", async () => {
    const r = rig();
    const d1 = await opened(r);
    r.chain.mine();
    await r.watcher.pollNow();
    r.chain.reorg(1);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("orphaned");

    expect(await r.s.verify(pay(1000n), req())).toMatchObject({
      isValid: false,
      invalidReason: REASON.depositRequired,
    });
  });
});

describe("settle atomicity", () => {
  test("20 concurrent settles of one voucher → exactly 1 success", async () => {
    const r = rig();
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);

    const results = await Promise.all(Array.from({ length: 20 }, () => r.s.settle(pay(500n, { txid: d1 }), req())));

    expect(results.filter((x) => x.success)).toEqual([expect.objectContaining({ transaction: d1, amount: "500" })]);
    expect(results.filter((x) => !x.success).map((x) => x.errorReason)).toEqual(
      Array(19).fill(REASON.cumulativeMismatch),
    );
    expect(r.ledger.replay()).toHaveLength(2);
  });

  test("out-of-order settles: c+1000 after c+1500 → cumulative_mismatch", async () => {
    const r = rig();
    await opened(r);

    expect(await r.s.settle(pay(2000n), req())).toMatchObject({ success: true, amount: "1500" });
    const late = await r.s.settle(pay(1500n), req());

    expect(late).toMatchObject({ success: false, errorReason: REASON.cumulativeMismatch, transaction: "" });
    expect(sessionOf(late).cumulativeZat).toBe("2000");
  });

  test("concurrent settles with one new deposit credit once", async () => {
    const r = rig();
    const d1 = await opened(r);
    const d2 = send(r.chain, { memo: `${K}:2` });
    expect((await r.s.verify(pay(1000n, { txid: d2 }), req())).isValid).toBe(true);
    await until(() => r.resolver.peek(d2) !== undefined);

    const results = await Promise.all([
      r.s.settle(pay(1000n, { txid: d2 }), req()),
      r.s.settle(pay(1500n, { txid: d2 }), req()),
    ]);

    expect(results).toMatchObject([
      { success: true, transaction: d2 },
      { success: true, transaction: d2 },
    ]);
    expect(creditedTxids(r.ledger)).toEqual([d1, d2]);
  });
});

describe("never deposit_required while a presented deposit is unresolved", () => {
  test("a settle while the needed deposit's lookup is in flight → awaiting_confirmation", async () => {
    const gate = gated();
    const r = rig(gate.wrap);
    const d1 = send(r.chain);
    gate.close(d1);

    const verifying = r.s.verify(pay(500n, { txid: d1 }), req());
    const early = await r.s.settle(pay(500n, { txid: d1 }), req());
    expect(early).toMatchObject({
      success: false,
      errorReason: REASON.awaitingConfirmation,
      transaction: "",
      payer: K,
    });
    expect(sessionOf(early).limitZat).toBe("0");

    gate.open(d1);
    expect((await verifying).isValid).toBe(true);
    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({ success: true, transaction: d1 });
  });

  test("verify passed lazily, then the limit dropped before settle → awaiting_confirmation", async () => {
    const gate = gated();
    const r = rig(gate.wrap);
    const d1 = await opened(r);
    r.chain.mine();
    await r.watcher.pollNow();
    const d2 = send(r.chain, { memo: `${K}:2` });
    gate.close(d2);
    expect((await r.s.verify(pay(1000n, { txid: d2 }), req())).isValid).toBe(true);

    r.chain.reorg(1);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("orphaned");

    const settled = await r.s.settle(pay(1000n, { txid: d2 }), req());
    expect(settled).toMatchObject({ success: false, errorReason: REASON.awaitingConfirmation, transaction: "" });
    expect(sessionOf(settled).limitZat).toBe("0");

    gate.open(d2);
    await until(() => !r.resolver.inFlight(d2));
    expect(await r.s.settle(pay(1000n, { txid: d2 }), req())).toMatchObject({ success: true, transaction: d2 });
  });

  test("a background lookup that rejected, then a settle that needs it → chain_unavailable", async () => {
    const broken = new Set<string>();
    const r = rig(crashing(broken));
    const d1 = await opened(r);
    r.chain.mine();
    await r.watcher.pollNow();
    const d2 = send(r.chain, { memo: `${K}:2` });
    broken.add(d2);
    expect((await r.s.verify(pay(1000n, { txid: d2 }), req())).isValid).toBe(true);
    await until(() => !r.resolver.inFlight(d2));
    expect(r.resolver.peek(d2)).toBeUndefined();

    r.chain.reorg(1);
    await r.watcher.pollNow();
    expect(r.state.deposit(d1)?.status).toBe("orphaned");

    const settled = await r.s.settle(pay(1000n, { txid: d2 }), req());
    expect(settled).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
      transaction: "",
      payer: K,
    });
    expect(sessionOf(settled).limitZat).toBe("0");
  });

  test("a settle whose needed deposit was never looked up → chain_unavailable, no chain read", async () => {
    const r = rig();
    const d1 = send(r.chain);
    const inspect = vi.spyOn(r.view, "inspect");

    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.chainUnavailable,
      transaction: "",
    });
    expect(inspect).not.toHaveBeenCalled();
  });
});

type Scenario = (r: Rig) => Promise<{ payer: string; responses: Array<VerifyResponse | SettleResponse> }>;

async function both(r: Rig, payload: PaymentPayload): Promise<Array<VerifyResponse | SettleResponse>> {
  return [await r.s.verify(payload, req()), await r.s.settle(payload, req())];
}

const REFUSALS: Array<[ReasonCode, Scenario]> = [
  [REASON.depositRequired, async (r) => ({ payer: K, responses: await both(r, pay(500n)) })],
  [
    REASON.cumulativeMismatch,
    async (r) => {
      const d1 = await opened(r);
      return { payer: K, responses: await both(r, pay(500n, { txid: d1 })) };
    },
  ],
  [
    REASON.awaitingConfirmation,
    async (r) => {
      await opened(r);
      return { payer: K, responses: await both(r, pay(100500n)) };
    },
  ],
  [
    REASON.depositMemoMismatch,
    async (r) => {
      const d1 = await opened(r);
      return { payer: OTHER_SESSION_KEY, responses: await both(r, pay(500n, { txid: d1, seed: OTHER_SEED })) };
    },
  ],
  [
    REASON.depositDead,
    async (r) => {
      const d1 = await opened(r);
      r.chain.hold(d1);
      r.chain.mine(41);
      await r.watcher.pollNow();
      return { payer: K, responses: await both(r, pay(1000n, { txid: d1 })) };
    },
  ],
  [REASON.depositNotFound, async (r) => ({ payer: K, responses: await both(r, pay(500n, { txid: "ee".repeat(32) })) })],
  [
    REASON.chainUnavailable,
    async (r) => {
      const d1 = send(r.chain);
      r.chain.setUnavailable(true);
      return { payer: K, responses: await both(r, pay(500n, { txid: d1 })) };
    },
  ],
  [
    REASON.depositTransparent,
    async (r) => ({ payer: K, responses: await both(r, pay(500n, { txid: send(r.chain, { hasTransparent: true }) })) }),
  ],
  [
    REASON.depositMemoMismatch,
    async (r) => ({ payer: K, responses: await both(r, pay(500n, { txid: send(r.chain, { to: OTHER_PAY_TO }) })) }),
  ],
  [
    REASON.depositMemoMismatch,
    async (r) => ({ payer: K, responses: await both(r, pay(500n, { txid: send(r.chain, { memo: "wrong" }) })) }),
  ],
];

describe("snapshot presence", () => {
  test.each(REFUSALS)("every post-signature refusal carries extra.session (%s)", async (code, scenario) => {
    const r = rig();
    const { payer, responses } = await scenario(r);

    for (const response of responses) {
      expect("isValid" in response ? response.invalidReason : response.errorReason).toBe(code);
      expect(response.payer).toBe(payer);
      expect(parseSessionSnapshot(response.extra?.session)).not.toBeNull();
      expect(sessionOf(response).sessionKey).toBe(payer);
    }
  });

  test.each<[ReasonCode, () => [PaymentPayload, PaymentRequirements]]>([
    [REASON.invalidPayload, () => [paymentFor(req(), { ...voucherFor(req(), 500n), cumulativeZat: "0500" }), req()]],
    [REASON.invalidPaymentRequirements, () => [pay(500n), req({ amount: "1000" })]],
    [REASON.invalidX402Version, () => [{ ...pay(500n), x402Version: 1 }, req()]],
    [REASON.invalidScheme, () => [{ ...pay(500n), accepted: req({ scheme: "exact" }) }, req()]],
    [REASON.invalidNetwork, () => [{ ...pay(500n), accepted: req({ network: NETWORK_TESTNET }) }, req()]],
    [REASON.invalidSignature, () => [paymentFor(req(), { ...voucherFor(req(), 500n), cumulativeZat: "1000" }), req()]],
  ])("pre-auth failures carry no snapshot (%s)", async (code, make) => {
    const r = rig();
    await opened(r);
    const [payload, requirements] = make();

    const verdict = await r.s.verify(payload, requirements);
    const settled = await r.s.settle(payload, requirements);

    expect(verdict).toMatchObject({ isValid: false, invalidReason: code });
    expect(settled).toMatchObject({ success: false, errorReason: code, transaction: "" });
    for (const response of [verdict, settled]) {
      expect(response).not.toHaveProperty("extra");
      expect(response).not.toHaveProperty("payer");
    }
  });
});

describe("unexpected failures", () => {
  test("a needed lookup that rejects → unexpected_verify_error, without snapshot and not fatal", async () => {
    const r = rig((view) => ({
      tip: () => view.tip(),
      inspect: async () => {
        throw new TypeError("inspect broke");
      },
    }));
    const d1 = send(r.chain);

    expect(await r.s.verify(pay(500n, { txid: d1 }), req())).toStrictEqual({
      isValid: false,
      invalidReason: REASON.unexpectedVerifyError,
      invalidMessage: expect.any(String),
    });
    expect(r.log).toHaveBeenCalledTimes(1);
    expect(r.log.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
    expect(r.onFatal).not.toHaveBeenCalled();
    expect(await r.s.verify(pay(500n), req())).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired });
  });

  test("a failed ledger write → unexpected_settle_error, onFatal once, and every later call refused", async () => {
    const r = rig();
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    const failure = new Error("ENOSPC: no space left on device, write");
    const append = vi.spyOn(r.ledger, "appendSync").mockImplementation(() => {
      throw failure;
    });

    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toStrictEqual({
      success: false,
      errorReason: REASON.unexpectedSettleError,
      errorMessage: expect.any(String),
      transaction: "",
      network: NETWORK,
    });
    expect(r.onFatal.mock.calls).toEqual([[failure]]);
    expect(r.log.mock.calls).toEqual([["ledger write failed — facilitator must restart"]]);
    expect(r.state.session(K)).toBeUndefined();

    append.mockRestore();
    expect(await r.s.verify(pay(500n, { txid: d1 }), req())).toStrictEqual({
      isValid: false,
      invalidReason: REASON.unexpectedVerifyError,
      invalidMessage: expect.any(String),
    });
    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toStrictEqual({
      success: false,
      errorReason: REASON.unexpectedSettleError,
      errorMessage: expect.any(String),
      transaction: "",
      network: NETWORK,
    });
    expect(r.ledger.replay()).toEqual([]);
    expect(r.onFatal).toHaveBeenCalledTimes(1);
  });

  test("a batch the ledger refuses → unexpected_settle_error, never fatal, and the next calls succeed", async () => {
    const r = rig();
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    const refusal = new LedgerRefusal("event 1 (deposit) is not a ledger event");
    vi.spyOn(r.ledger, "appendSync").mockImplementationOnce(() => {
      throw refusal;
    });

    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toStrictEqual({
      success: false,
      errorReason: REASON.unexpectedSettleError,
      errorMessage: expect.any(String),
      transaction: "",
      network: NETWORK,
    });
    expect(r.onFatal).not.toHaveBeenCalled();
    expect(r.log.mock.calls).toEqual([["settle batch refused", refusal]]);
    expect(r.ledger.replay()).toEqual([]);

    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({ success: true, transaction: d1 });
  });

  test("a settle whose snapshot cannot be built after its commit still reports the committed charge", async () => {
    const r = rig();
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    const real = r.state.depositsOf.bind(r.state);
    let reads = 0;
    vi.spyOn(r.state, "depositsOf").mockImplementation((key) => {
      if (++reads === 2) throw new Error("snapshot broke");
      return real(key);
    });

    const settled = await r.s.settle(pay(500n, { txid: d1 }), req());

    expect(settled).toStrictEqual({ success: true, transaction: d1, network: NETWORK, payer: K, amount: "500" });
    expect(r.ledger.replay().map((e) => e.t)).toEqual(["deposit", "voucher"]);
    expect(r.log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "snapshot broke" }));
    expect(r.onFatal).not.toHaveBeenCalled();
  });

  test("a verify still waiting on the chain when the ledger fails is refused as well", async () => {
    const gate = gated();
    const r = rig(gate.wrap);
    const d1 = send(r.chain);
    expect((await r.s.verify(pay(500n, { txid: d1 }), req())).isValid).toBe(true);
    const d2 = send(r.chain, { memo: `${OTHER_SESSION_KEY}:1` });
    gate.close(d2);
    const waiting = r.s.verify(pay(500n, { txid: d2, seed: OTHER_SEED }), req());
    vi.spyOn(r.ledger, "appendSync").mockImplementation(() => {
      throw new Error("EIO: i/o error, write");
    });

    expect(await r.s.settle(pay(500n, { txid: d1 }), req())).toMatchObject({
      success: false,
      errorReason: REASON.unexpectedSettleError,
    });
    gate.open(d2);

    expect(await waiting).toStrictEqual({
      isValid: false,
      invalidReason: REASON.unexpectedVerifyError,
      invalidMessage: expect.any(String),
    });
  });
});

describe("advertised terms and configuration", () => {
  test("getExtra advertises terms, payTo and termsVersion", () => {
    const { s } = rig();

    const extra = s.getExtra(NETWORK);

    expect(extra).toEqual({
      windowZat: "100000",
      creditRatioBps: 2500,
      creditCapZat: "200000",
      zeroConfMinExpiryBlocks: 20,
      termsVersion: TERMS_VERSION,
      payTo: PAY_TO,
    });
    expect(extra.termsVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(s.getSigners(NETWORK)).toEqual([]);
  });

  test("termsVersion moves with payTo, price and every term", () => {
    const versions = [
      termsVersion(PAY_TO, 500n, DEMO_TERMS),
      termsVersion(OTHER_PAY_TO, 500n, DEMO_TERMS),
      termsVersion(PAY_TO, 1000n, DEMO_TERMS),
      termsVersion(PAY_TO, 500n, { ...DEMO_TERMS, windowZat: 200000n }),
      termsVersion(PAY_TO, 500n, { ...DEMO_TERMS, creditRatioBps: 5000 }),
      termsVersion(PAY_TO, 500n, { ...DEMO_TERMS, creditCapZat: 100000n }),
      termsVersion(PAY_TO, 500n, { ...DEMO_TERMS, zeroConfMinExpiryBlocks: 10 }),
    ];

    expect(versions[0]).toBe(TERMS_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test.each<[string, Partial<SchemeConfig>, RegExp]>([
    ["a price of 0, under which a replayed voucher would pass", { priceZat: 0n }, /priceZat/],
    ["a payTo of another network", { payTo: `utest1${"q".repeat(60)}` }, /payTo/],
    ["a network that is not Zcash", { network: "eip155:1" as ZcashNetwork }, /network/],
    ["terms the wire cannot carry", { terms: { ...DEMO_TERMS, creditRatioBps: 10001 } }, /terms/],
    ["a deposit wait of Infinity, which would poll forever", { depositWaitMs: Infinity }, /^depositWaitMs:/],
    ["a deposit wait below zero", { depositWaitMs: -1 }, /^depositWaitMs:/],
    ["a deposit wait past 30 s", { depositWaitMs: 30_001 }, /^depositWaitMs: expected a whole number from 0 to 30000$/],
    ["a refresh wait below zero", { refreshWaitMs: -1 }, /^refreshWaitMs:/],
    ["a refresh wait past 5 s", { refreshWaitMs: 5001 }, /^refreshWaitMs: expected a whole number from 0 to 5000$/],
  ])("the constructor refuses %s", (_, over, field) => {
    const { state, resolver, watcher } = rig();

    expect(
      () =>
        new PrepaidVoucherFacilitatorScheme({
          config: { ...CONFIG, ...over },
          state,
          resolver,
          watcher,
          commit: () => undefined,
        }),
    ).toThrow(field);
  });

  test("takes the longest waits whose worst case the API's 60 s for a verify was sized for", () => {
    const { state, resolver, watcher } = rig();
    const config = { ...CONFIG, depositWaitMs: 30_000, refreshWaitMs: 5000 };
    expect(
      () => new PrepaidVoucherFacilitatorScheme({ config, state, resolver, watcher, commit: () => undefined }),
    ).not.toThrow();
  });
});
