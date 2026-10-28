import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ASSET, DEMO_TERMS, encodeTerms, NETWORK_REGTEST, REASON, SCHEME, type ChainView } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { providerId } from "../src/providers/id.js";
import { openRuntime, type ProviderRuntime, type RuntimeOptions } from "../src/runtime.js";
import { termsVersion } from "../src/termsVersion.js";
import { paymentFor, SESSION_KEY as K, voucherFor } from "./support/vouchers.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const W = 100000n;

const scratch = mkdtempSync(join(tmpdir(), "z402-runtime-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const opened: ProviderRuntime[] = [];
afterEach(() => {
  for (const runtime of opened.splice(0)) {
    runtime.stop();
    runtime.release();
  }
});

const quiet = () => undefined;
let counter = 0;
const ledger = (name: string) => join(scratch, `${name}-${counter++}`, "ledger.jsonl");

async function open(over: Partial<RuntimeOptions> = {}, chain = new FakeChain({ expiryDelta: 40 })) {
  const runtime = await openRuntime({
    network: NETWORK,
    payTo: PAY_TO,
    chain: chain.viewFor(PAY_TO),
    priceZat: 500n,
    terms: DEMO_TERMS,
    onFatal: quiet,
    log: quiet,
    ...over,
  });
  opened.push(runtime);
  return { runtime, chain };
}

function requirements(runtime: ProviderRuntime, over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  const { payTo: _payTo, ...terms } = runtime.extra();
  return {
    scheme: SCHEME,
    network: NETWORK,
    asset: ASSET,
    amount: "500",
    payTo: runtime.payTo,
    maxTimeoutSeconds: 60,
    extra: terms,
    ...over,
  };
}

const pay = (r: PaymentRequirements, c: bigint, txid?: string): PaymentPayload =>
  paymentFor(r, voucherFor(r, c, { depositTxid: txid }));

const deposit = (chain: FakeChain): string =>
  chain.broadcast({ outputs: [{ to: PAY_TO, valueZat: W, memo: `${K}:1` }] });

/** The verify that makes the chain's deposit known, then the settle that records the voucher */
async function paid(runtime: ProviderRuntime, r: PaymentRequirements, c: bigint, txid?: string) {
  const payload = pay(r, c, txid);
  expect(await runtime.facilitator.verify(payload, r)).toMatchObject({ isValid: true });
  return runtime.facilitator.settle(payload, r);
}

const ledgerTypes = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { t: string }).t)
    .filter((t) => t !== "ledger");

/** A view whose inspect waits for open() once shut() is called, and `reached` settles when a read is waiting */
function gated(view: ChainView) {
  let shut = false;
  let open = () => {};
  let arrive = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gatedView: ChainView = {
    tip: () => view.tip(),
    inspect: async (txid) => {
      if (shut) {
        arrive();
        await opened;
      }
      return view.inspect(txid);
    },
  };
  return {
    view: gatedView,
    shut: () => {
      shut = true;
    },
    open,
    reached,
  };
}

describe("openRuntime", () => {
  test("names the provider by its network and payTo", async () => {
    const { runtime } = await open();
    expect(runtime).toMatchObject({ id: providerId(NETWORK, PAY_TO), network: NETWORK, payTo: PAY_TO });
    expect(runtime.id).toBe("f93eeecbf393ea04");
  });

  test("extra() is what its x402Facilitator advertises: the terms, their version and the payTo", async () => {
    const { runtime } = await open();
    const termsVersionOf = termsVersion(PAY_TO, 500n, DEMO_TERMS);
    const expected = { ...encodeTerms(DEMO_TERMS), termsVersion: termsVersionOf, payTo: PAY_TO };
    expect(runtime.extra()).toEqual(expected);
    expect(runtime.facilitator.getSupported().kinds).toEqual([
      { x402Version: 2, scheme: SCHEME, network: NETWORK, extra: expected },
    ]);
  });

  test("extra() hands out a copy, so a caller cannot change what is advertised", async () => {
    const { runtime } = await open();
    (runtime.extra() as Record<string, unknown>).payTo = "elsewhere";
    expect(runtime.extra().payTo).toBe(PAY_TO);
  });

  test("its facilitator verifies and settles a payment to its payTo", async () => {
    const { runtime, chain } = await open({ ledgerPath: ledger("pays") });
    const r = requirements(runtime);
    const d1 = deposit(chain);
    expect(await runtime.facilitator.verify(pay(r, 500n, d1), r)).toMatchObject({ isValid: true, payer: K });
    expect(await runtime.facilitator.settle(pay(r, 500n, d1), r)).toMatchObject({
      success: true,
      transaction: d1,
      network: NETWORK,
      amount: "500",
    });
  });

  test("its facilitator refuses requirements for another payTo", async () => {
    const { runtime } = await open();
    const r = requirements(runtime, { payTo: OTHER_PAY_TO });
    expect(await runtime.facilitator.verify(pay(r, 500n), r)).toMatchObject({
      isValid: false,
      invalidReason: REASON.invalidPaymentRequirements,
    });
    expect(await runtime.facilitator.settle(pay(r, 500n), r)).toMatchObject({
      success: false,
      errorReason: REASON.invalidPaymentRequirements,
    });
  });

  test("a runtime with a ledgerPath writes the header, then replays what an earlier one wrote", async () => {
    const ledgerPath = ledger("replay");
    const first = await open({ ledgerPath });
    expect(readFileSync(ledgerPath, "utf8")).toBe(
      `${JSON.stringify({ t: "ledger", network: NETWORK, payTo: PAY_TO })}\n`,
    );
    const r = requirements(first.runtime);
    await paid(first.runtime, r, 500n, deposit(first.chain));
    first.runtime.stop();
    first.runtime.release();

    const second = await open({ ledgerPath }, first.chain);
    const stale = await second.runtime.facilitator.verify(pay(r, 500n), r);
    expect(stale).toMatchObject({ isValid: false, invalidReason: REASON.cumulativeMismatch });
  });

  test("a ledger of another payTo is refused and its lock is given back", async () => {
    const ledgerPath = ledger("other");
    const first = await open({ payTo: OTHER_PAY_TO, chain: new FakeChain().viewFor(OTHER_PAY_TO), ledgerPath });
    first.runtime.release();

    await expect(open({ ledgerPath })).rejects.toThrow(/^ledgerPath: .* is the ledger of zcash:regtest u.*, not of/);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  test("a configuration the scheme refuses names the field and gives the ledger lock back", async () => {
    const ledgerPath = ledger("refused");
    await expect(open({ ledgerPath, priceZat: 0n })).rejects.toThrow(/^priceZat:/);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
    await expect(open({ ledgerPath })).resolves.toBeDefined();
  });

  test("runtimes without a ledgerPath hold no lock and keep ledgers of their own in memory", async () => {
    const first = await open();
    const second = await open();
    const r = requirements(first.runtime);
    expect(await paid(first.runtime, r, 500n, deposit(first.chain))).toMatchObject({ success: true });

    const other = await second.runtime.facilitator.verify(pay(r, 500n), r);
    expect(other).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired });
    expect(other.extra).toMatchObject({ session: { cumulativeZat: "0" } });
  });
});

describe("a runtime's lifecycle", () => {
  test("release() frees the ledger for the next open, and does nothing the second time", async () => {
    const ledgerPath = ledger("release");
    const { runtime } = await open({ ledgerPath });
    expect(existsSync(`${ledgerPath}.lock`)).toBe(true);
    await expect(open({ ledgerPath })).rejects.toThrow(/^ledgerPath: .*already open/);

    runtime.release();
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
    runtime.release();
    const again = await open({ ledgerPath });
    expect(existsSync(`${ledgerPath}.lock`)).toBe(true);
    again.runtime.release();
  });

  test("start() runs the watcher on pollIntervalMs by itself, and stop() ends it", async () => {
    const view = new FakeChain({ expiryDelta: 40 });
    const counting = { tip: 0 };
    const chain: ChainView = {
      tip: () => (counting.tip++, view.viewFor(PAY_TO).tip()),
      inspect: (txid) => view.viewFor(PAY_TO).inspect(txid),
    };
    const { runtime } = await open({ chain, pollIntervalMs: 20 }, view);
    expect(counting.tip).toBe(0);

    runtime.start();
    await vi.waitFor(() => expect(counting.tip).toBeGreaterThan(2), { timeout: 3000, interval: 10 });
    runtime.stop();
    const stopped = counting.tip;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counting.tip).toBe(stopped);
  });

  test("start() brings a deposit up to date without anyone calling pollNow()", async () => {
    const ledgerPath = ledger("watches");
    const { runtime, chain } = await open({ ledgerPath, pollIntervalMs: 20 });
    const r = requirements(runtime);
    await paid(runtime, r, 500n, deposit(chain));
    runtime.start();

    chain.mine(1);
    await vi.waitFor(() => expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher", "status"]), {
      timeout: 3000,
      interval: 10,
    });
  });

  test("pollNow() reads nothing and writes nothing once the runtime is stopped", async () => {
    const view = new FakeChain({ expiryDelta: 40 }).viewFor(PAY_TO);
    const reads = { tip: 0, inspect: 0 };
    const counting: ChainView = {
      tip: () => (reads.tip++, view.tip()),
      inspect: (txid) => (reads.inspect++, view.inspect(txid)),
    };
    const { runtime } = await open({ chain: counting });
    runtime.stop();

    const before = { ...reads };
    await runtime.pollNow();
    expect(reads).toEqual(before);
  });

  test("pollNow() brings every live deposit up to date", async () => {
    const ledgerPath = ledger("polls");
    const { runtime, chain } = await open({ ledgerPath });
    const r = requirements(runtime);
    await paid(runtime, r, 500n, deposit(chain));

    chain.mine(1);
    await runtime.pollNow();
    expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher", "status"]);
  });

  test("a pass in flight when stop() runs writes nothing when it resumes", async () => {
    const ledgerPath = ledger("in-flight");
    const chain = new FakeChain({ expiryDelta: 40 });
    const gate = gated(chain.viewFor(PAY_TO));
    const onFatal = vi.fn<(err: unknown) => void>();
    const log = vi.fn<(msg: string, err?: unknown) => void>();
    const { runtime } = await open({ chain: gate.view, ledgerPath, onFatal, log }, chain);
    const r = requirements(runtime);
    const d1 = deposit(chain);
    await runtime.facilitator.verify(pay(r, 500n, d1), r);
    await runtime.facilitator.settle(pay(r, 500n, d1), r);
    chain.mine(1);

    gate.shut();
    const pass = runtime.pollNow();
    await gate.reached;
    const logged = log.mock.calls.length;
    runtime.stop();
    gate.open();
    await pass;

    expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher"]);
    expect(onFatal).not.toHaveBeenCalled();
    expect(log.mock.calls.slice(logged)).toEqual([]);
  });

  test("a settle that is in flight when stop() runs is still recorded", async () => {
    const ledgerPath = ledger("settles-after-stop");
    const { runtime, chain } = await open({ ledgerPath });
    const r = requirements(runtime);
    await paid(runtime, r, 500n, deposit(chain));

    runtime.stop();
    const res = await runtime.facilitator.settle(pay(r, 1000n), r);
    expect(res).toMatchObject({ success: true, amount: "500" });
    expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher", "voucher"]);
  });

  test("stop() may be called twice and before start()", async () => {
    const { runtime } = await open();
    runtime.stop();
    runtime.stop();
    runtime.start();
    runtime.stop();
  });
});

describe("a runtime's failures reach onFatal", () => {
  test("a ledger write that fails calls it once and poisons the runtime", async () => {
    const ledgerPath = ledger("fatal");
    const onFatal = vi.fn<(err: unknown) => void>();
    const { runtime, chain } = await open({ ledgerPath, onFatal });
    const r = requirements(runtime);
    const d1 = deposit(chain);
    expect((await runtime.facilitator.verify(pay(r, 500n, d1), r)).isValid).toBe(true);

    // A directory where the file belongs makes the next append fail with EISDIR
    rmSync(ledgerPath);
    mkdirSync(ledgerPath);
    const res = await runtime.facilitator.settle(pay(r, 500n, d1), r);
    expect(res).toMatchObject({ success: false, errorReason: REASON.unexpectedSettleError });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
  });
});
