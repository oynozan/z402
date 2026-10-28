import { DEMO_TERMS, type FoundInspection } from "@z402/protocol";
import { describe, expect, test } from "vitest";
import { evaluateDeposit } from "../../src/core/evaluate.js";

const K = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const W = 100000n;
const tip = 4547300;

const out = (valueZat: bigint, memo: string | null) => ({ pool: "ironwood" as const, valueZat, memo });

function ev(over: Partial<FoundInspection> = {}) {
  const insp: FoundInspection = {
    found: true,
    txid: "e1".repeat(32),
    location: "mempool",
    minedHeight: null,
    expiryHeight: tip + 100,
    hasTransparent: false,
    outputs: [out(W, `${K}:1`)],
    ...over,
  };
  return evaluateDeposit(insp, K, DEMO_TERMS, tip);
}

describe("evaluateDeposit refusals", () => {
  test("a clean mempool deposit is pending with zero confirmations", () => {
    expect(ev()).toEqual({
      ok: true,
      valueZat: 100000n,
      zeroConf: true,
      status: "pending",
      minedHeight: null,
      confirmations: 0,
      expiryHeight: tip + 100,
    });
  });

  test("transparent part wins", () => {
    expect(ev({ hasTransparent: true, outputs: [out(W, `${K}:1`)] })).toEqual({
      ok: false,
      code: "z402_deposit_transparent",
    });
  });

  test("transparent part wins over missing outputs and expiry", () => {
    expect(ev({ hasTransparent: true, outputs: [], expiryHeight: tip })).toEqual({
      ok: false,
      code: "z402_deposit_transparent",
    });
  });

  test("no outputs to payTo answers memo_mismatch, so the code never tells whether a tx pays the merchant", () => {
    expect(ev({ outputs: [] })).toEqual({ ok: false, code: "z402_deposit_memo_mismatch" });
  });

  test("no outputs to payTo is reported before expiry", () => {
    expect(ev({ outputs: [], expiryHeight: tip })).toEqual({ ok: false, code: "z402_deposit_memo_mismatch" });
  });

  test.each([`${OTHER}:1`, `${K}:01`, `${K}:1 `, `${K.toUpperCase()}:1`, K, null])(
    "memo %j does not match the session",
    (memo) => {
      expect(ev({ outputs: [out(W, memo)] })).toEqual({ ok: false, code: "z402_deposit_memo_mismatch" });
    },
  );

  test("a memo mismatch is reported before expiry", () => {
    expect(ev({ outputs: [out(W, null)], expiryHeight: tip })).toEqual({
      ok: false,
      code: "z402_deposit_memo_mismatch",
    });
  });

  test("unmined at expiry is dead", () => {
    expect(ev({ location: "mempool", expiryHeight: tip })).toEqual({ ok: false, code: "z402_deposit_dead" });
  });

  test("unmined one block before expiry is not dead", () => {
    expect(ev({ location: "mempool", expiryHeight: tip + 1 })).toMatchObject({ ok: true, status: "pending" });
  });

  test("a deposit seen on a side chain after its expiry is dead", () => {
    expect(ev({ location: "orphaned", expiryHeight: tip })).toEqual({ ok: false, code: "z402_deposit_dead" });
  });

  test("a mined deposit is not dead even past its expiry", () => {
    expect(ev({ location: "mined", minedHeight: tip - 5, expiryHeight: tip - 3 })).toMatchObject({
      ok: true,
      status: "confirmed",
      confirmations: 6,
    });
  });
});

describe("evaluateDeposit value", () => {
  test("matching outputs are summed", () => {
    expect(ev({ outputs: [out(60000n, `${K}:1`), out(40000n, `${K}:7`)] })).toMatchObject({
      ok: true,
      valueZat: 100000n,
      zeroConf: true,
    });
  });

  test("outputs for other memos are not counted", () => {
    const outputs = [out(60000n, `${K}:1`), out(70000n, `${OTHER}:1`), out(5000n, null), out(40000n, `${K}:2`)];
    expect(ev({ outputs })).toMatchObject({ ok: true, valueZat: 100000n });
  });

  test("sub-window counts later", () => {
    expect(ev({ outputs: [out(99999n, `${K}:1`)] })).toMatchObject({ ok: true, valueZat: 99999n, zeroConf: false });
  });

  test.each([
    [tip + 19, false],
    [tip + 20, true],
    [0, true],
  ])("expiry %i zeroConf %s", (expiryHeight, zeroConf) => {
    expect(ev({ expiryHeight })).toMatchObject({ ok: true, zeroConf });
  });
});

describe("evaluateDeposit at a newer tip than the deposit's first sighting at 1001", () => {
  const insp: FoundInspection = {
    found: true,
    txid: "e1".repeat(32),
    location: "mempool",
    minedHeight: null,
    expiryHeight: 1042,
    hasTransparent: false,
    outputs: [out(W, `${K}:1`)],
  };

  test("death is judged at the current tip", () => {
    expect(evaluateDeposit(insp, K, DEMO_TERMS, 1042, 1001)).toEqual({ ok: false, code: "z402_deposit_dead" });
  });

  test("zero-conf is judged at the tip of the first sighting", () => {
    expect(evaluateDeposit(insp, K, DEMO_TERMS, 1030, 1001)).toMatchObject({
      ok: true,
      status: "pending",
      zeroConf: true,
    });
  });

  test("without a reference tip, zero-conf is judged at the tip given", () => {
    expect(evaluateDeposit(insp, K, DEMO_TERMS, 1030)).toMatchObject({ ok: true, zeroConf: false });
  });
});

describe("evaluateDeposit status", () => {
  test("height ahead of tip is 1 confirmation", () => {
    expect(ev({ location: "mined", minedHeight: tip + 1 })).toMatchObject({
      status: "confirmed",
      minedHeight: tip + 1,
      confirmations: 1,
    });
  });

  test.each([
    [tip, 1, "confirmed"],
    [tip - 8, 9, "confirmed"],
    [tip - 9, 10, "final"],
    [tip - 500, 501, "final"],
  ])("mined at %i is %i confirmations, %s", (minedHeight, confirmations, status) => {
    expect(ev({ location: "mined", minedHeight })).toMatchObject({ ok: true, status, minedHeight, confirmations });
  });

  test("a side-chain deposit is orphaned with no height", () => {
    expect(ev({ location: "orphaned" })).toMatchObject({
      ok: true,
      status: "orphaned",
      minedHeight: null,
      confirmations: 0,
    });
  });
});
