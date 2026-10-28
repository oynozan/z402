import type { FoundInspection, TxInspection } from "@z402/protocol";
import { describe, expect, test } from "vitest";
import { asOfTip, observe } from "../../src/core/transitions.js";
import type { DepositRecord } from "../../src/core/types.js";
import { record, SESSION_KEY, TIP } from "./records.js";

const TXID = "e1".repeat(32);
const T0 = 1_700_000_000_000;
const MISSING: TxInspection = { found: false };

const rec = (over: Partial<DepositRecord> = {}) => record({ txid: TXID, ...over });

function found(
  location: FoundInspection["location"],
  minedHeight: number | null = null,
  expiryHeight = TIP + 40,
): FoundInspection {
  return { found: true, txid: TXID, location, minedHeight, expiryHeight, hasTransparent: false, outputs: [] };
}
const mempool = () => found("mempool");
const mined = (height: number) => found("mined", height);
const orphaned = () => found("orphaned");

const confirmed = (over: Partial<DepositRecord> = {}) =>
  rec({ status: "confirmed", minedHeight: TIP - 1, confirmations: 2, ...over });

describe("observe: the rows of design 4.1", () => {
  test("in the mempool is pending", () => {
    const input = rec();
    const next = observe(input, mempool(), TIP, T0);
    expect(next).toEqual(input);
    expect(next).not.toBe(input);
  });

  test.each([
    [TIP, 1],
    [TIP - 8, 9],
  ])("mined at %i is %i confirmations and confirmed", (height, confirmations) => {
    expect(observe(rec(), mined(height), TIP, T0)).toMatchObject({
      status: "confirmed",
      minedHeight: height,
      confirmations,
    });
  });

  test("a mined height ahead of the cached tip is 1 confirmation", () => {
    expect(observe(rec(), mined(TIP + 1), TIP, T0)).toMatchObject({
      status: "confirmed",
      minedHeight: TIP + 1,
      confirmations: 1,
    });
  });

  test.each([
    [TIP - 9, 10],
    [TIP - 40, 41],
  ])("mined at %i is %i confirmations and final", (height, confirmations) => {
    expect(observe(rec(), mined(height), TIP, T0)).toMatchObject({
      status: "final",
      minedHeight: height,
      confirmations,
    });
  });

  test("a confirmed deposit becomes final on the tenth confirmation", () => {
    const input = confirmed({ minedHeight: TIP - 8, confirmations: 9 });
    expect(observe(input, mined(TIP - 8), TIP + 1, T0)).toMatchObject({ status: "final", confirmations: 10 });
  });

  test("a confirmed deposit keeps counting confirmations", () => {
    expect(observe(confirmed(), mined(TIP - 1), TIP + 3, T0)).toMatchObject({ status: "confirmed", confirmations: 5 });
  });

  test("mined on a side chain is orphaned", () => {
    expect(observe(rec(), orphaned(), TIP, T0)).toMatchObject({
      status: "orphaned",
      minedHeight: null,
      confirmations: 0,
    });
  });

  test("an orphaned deposit that is mined on the main chain is confirmed", () => {
    const input = rec({ status: "orphaned" });
    expect(observe(input, mined(TIP), TIP, T0)).toMatchObject({ status: "confirmed", minedHeight: TIP });
  });

  test("unmined at tip >= expiry is dead, remembering the tip", () => {
    const input = rec({ expiryHeight: TIP });
    expect(observe(input, found("mempool", null, TIP), TIP, T0)).toMatchObject({
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip: TIP,
    });
  });

  test("unmined one block before expiry is still pending", () => {
    const input = rec({ expiryHeight: TIP + 1 });
    expect(observe(input, found("mempool", null, TIP + 1), TIP, T0)).toMatchObject({
      status: "pending",
      deadAtTip: null,
    });
  });

  test("expiry 0 never expires", () => {
    const input = rec({ expiryHeight: 0 });
    expect(observe(input, found("mempool", null, 0), TIP + 5000, T0)).toMatchObject({ status: "pending" });
  });

  test("not found at tip >= expiry is dead without waiting out a streak", () => {
    const input = rec({ expiryHeight: TIP });
    expect(observe(input, MISSING, TIP, T0)).toMatchObject({ status: "dead", deadAtTip: TIP, notFound: null });
  });
});

describe("observe: demotion", () => {
  test("confirmed demoted on mempool", () => {
    expect(observe(confirmed(), mempool(), TIP, T0)).toMatchObject({
      status: "pending",
      minedHeight: null,
      confirmations: 0,
    });
  });

  test("confirmed demoted on orphaned", () => {
    expect(observe(confirmed(), orphaned(), TIP, T0)).toMatchObject({
      status: "orphaned",
      minedHeight: null,
      confirmations: 0,
    });
  });

  test("confirmed that goes missing is demoted only when the not-found streak matures", () => {
    const first = observe(confirmed(), MISSING, TIP, T0);
    expect(first).toMatchObject({ status: "confirmed", notFound: { sinceMs: T0, sinceTip: TIP } });
    expect(observe(first, MISSING, TIP + 2, T0 + 120_000)).toMatchObject({
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip: TIP + 2,
    });
  });
});

describe("observe: not-found streaks", () => {
  test("the first not-found answer starts a streak and changes no status", () => {
    const input = rec();
    expect(observe(input, MISSING, TIP, T0)).toEqual({ ...input, notFound: { sinceMs: T0, sinceTip: TIP } });
  });

  test.each([
    [119_000, 5],
    [119_999, 2],
    [120_000, 1],
    [900_000, 1],
    [120_000, 0],
  ])("not-found for %i ms and %i new blocks stays pending", (ms, blocks) => {
    const input = rec({ notFound: { sinceMs: T0, sinceTip: TIP } });
    expect(observe(input, MISSING, TIP + blocks, T0 + ms)).toMatchObject({
      status: "pending",
      deadAtTip: null,
      notFound: { sinceMs: T0, sinceTip: TIP },
    });
  });

  test.each([
    [120_000, 2],
    [300_000, 9],
  ])("not-found for %i ms and %i new blocks is dead", (ms, blocks) => {
    const input = rec({ notFound: { sinceMs: T0, sinceTip: TIP } });
    expect(observe(input, MISSING, TIP + blocks, T0 + ms)).toMatchObject({
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip: TIP + blocks,
    });
  });

  test.each<DepositRecord["status"]>(["pending", "confirmed", "orphaned"])(
    "a %s deposit that stays missing for 120 s and 2 blocks is dead",
    (status) => {
      const input = rec({ status, notFound: { sinceMs: T0, sinceTip: TIP } });
      expect(observe(input, MISSING, TIP + 2, T0 + 120_000)).toMatchObject({ status: "dead", deadAtTip: TIP + 2 });
    },
  );

  test("the streak keeps its first answer as its start", () => {
    let r = observe(rec(), MISSING, TIP, T0);
    r = observe(r, MISSING, TIP + 1, T0 + 60_000);
    expect(r).toMatchObject({ status: "pending", notFound: { sinceMs: T0, sinceTip: TIP } });
    r = observe(r, MISSING, TIP + 2, T0 + 120_000);
    expect(r.status).toBe("dead");
  });

  test("a found answer in between resets the streak", () => {
    let r = observe(rec(), MISSING, TIP, T0);
    r = observe(r, MISSING, TIP + 1, T0 + 100_000);
    r = observe(r, mempool(), TIP + 1, T0 + 110_000);
    expect(r).toMatchObject({ status: "pending", notFound: null });

    r = observe(r, MISSING, TIP + 3, T0 + 130_000);
    expect(r).toMatchObject({ status: "pending", notFound: { sinceMs: T0 + 130_000, sinceTip: TIP + 3 } });
    r = observe(r, MISSING, TIP + 5, T0 + 249_000);
    expect(r.status).toBe("pending");
    r = observe(r, MISSING, TIP + 5, T0 + 250_000);
    expect(r).toMatchObject({ status: "dead", deadAtTip: TIP + 5 });
  });

  test.each([
    ["mempool", mempool],
    ["mined", () => mined(TIP)],
    ["orphaned", orphaned],
  ])("a %s answer clears the streak", (_where, answer) => {
    const input = rec({ notFound: { sinceMs: T0, sinceTip: TIP } });
    expect(observe(input, answer(), TIP + 1, T0 + 10_000).notFound).toBeNull();
  });
});

describe("observe: dead deposits", () => {
  const dead = (deadAtTip: number | null, over: Partial<DepositRecord> = {}) =>
    rec({ status: "dead", deadAtTip, ...over });

  test("dead resurrects to confirmed within 20 blocks", () => {
    expect(observe(dead(TIP - 20), mined(TIP), TIP, T0)).toMatchObject({
      status: "confirmed",
      minedHeight: TIP,
      confirmations: 1,
      deadAtTip: null,
      notFound: null,
    });
  });

  test.each([TIP - 21, TIP - 500, null])("dead with deadAtTip %s stays dead when found mined", (deadAtTip) => {
    expect(observe(dead(deadAtTip), mined(TIP), TIP, T0)).toMatchObject({
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip,
    });
  });

  test("a resurrected deposit is confirmed, even when it already has many confirmations", () => {
    expect(observe(dead(TIP - 15), mined(TIP - 14), TIP, T0)).toMatchObject({
      status: "confirmed",
      confirmations: 15,
    });
  });

  test("dead never goes back to pending", () => {
    expect(observe(dead(TIP - 5), mempool(), TIP, T0)).toMatchObject({ status: "dead", deadAtTip: TIP - 5 });
  });

  test.each([
    ["orphaned", orphaned],
    ["not found", () => MISSING],
  ])("dead stays dead when the answer is %s", (_where, answer) => {
    expect(observe(dead(TIP - 5), answer(), TIP, T0)).toMatchObject({
      status: "dead",
      deadAtTip: TIP - 5,
      notFound: null,
    });
  });

  test.each([
    ["mempool", () => found("mempool", null, TIP - 5)],
    ["not found", () => MISSING],
  ])("a %s answer past expiry does not move the recorded death", (_where, answer) => {
    const input = dead(TIP - 5, { expiryHeight: TIP - 5 });
    expect(observe(input, answer(), TIP, T0)).toMatchObject({ status: "dead", deadAtTip: TIP - 5, notFound: null });
  });
});

describe("observe: final and purity", () => {
  test.each([
    ["mempool", mempool],
    ["orphaned", orphaned],
    ["not found", () => MISSING],
  ])("final ignores a %s answer", (_where, answer) => {
    const input = rec({ status: "final", minedHeight: TIP - 20, confirmations: 21 });
    const next = observe(input, answer(), TIP + 500, T0 + 1_000_000);
    expect(next).toEqual(input);
    expect(next).not.toBe(input);
  });

  test("it never mutates its input", () => {
    const streak = Object.freeze({ sinceMs: T0, sinceTip: TIP });
    const inputs = [Object.freeze(rec()), Object.freeze(rec({ notFound: streak }))];
    const answers: Array<[TxInspection, number, number]> = [
      [mempool(), TIP + 1, T0 + 1000],
      [mined(TIP), TIP + 1, T0 + 1000],
      [orphaned(), TIP + 1, T0 + 1000],
      [MISSING, TIP + 1, T0 + 1000],
      [MISSING, TIP + 2, T0 + 120_000],
    ];
    for (const input of inputs) {
      const before = structuredClone(input);
      for (const [answer, tip, now] of answers) observe(input, answer, tip, now);
      expect(input).toEqual(before);
    }
  });

  test("zeroConf, valueZat and firstSeenTip never change", () => {
    const facts = {
      txid: TXID,
      sessionKey: SESSION_KEY,
      valueZat: 123456n,
      zeroConf: false,
      expiryHeight: TIP + 40,
      firstSeenTip: TIP - 7,
    };
    let r = rec(facts);
    const steps: Array<[TxInspection, number, number]> = [
      [MISSING, TIP, T0],
      [mempool(), TIP, T0 + 1000],
      [mined(TIP), TIP, T0 + 2000],
      [mempool(), TIP + 1, T0 + 3000],
      [orphaned(), TIP + 1, T0 + 4000],
      [MISSING, TIP + 1, T0 + 10_000],
      [MISSING, TIP + 3, T0 + 130_000],
      [mined(TIP + 4), TIP + 4, T0 + 140_000],
      [mined(TIP + 4), TIP + 14, T0 + 150_000],
    ];
    for (const [answer, tip, now] of steps) {
      r = observe(r, answer, tip, now);
      expect(r).toMatchObject(facts);
    }
    expect(r.status).toBe("final");
  });
});

describe("observe: the expiry shortcut on a confirmed record", () => {
  test("a confirmed record that reads not-found once its tip reached the expiry is dead at once", () => {
    const input = confirmed({ expiryHeight: 160 });
    expect(observe(input, MISSING, 160, T0)).toMatchObject({
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip: 160,
    });
  });
});

describe("asOfTip", () => {
  test("a pending record with expiry 160 is unchanged at tip 159 and dead at tip 160", () => {
    const input = rec({ expiryHeight: 160 });
    expect(asOfTip(input, 159)).toBe(input);
    expect(asOfTip(input, 160)).toEqual({
      ...input,
      status: "dead",
      minedHeight: null,
      confirmations: 0,
      deadAtTip: 160,
    });
  });

  test("a pending record with expiry 0 never expires", () => {
    const input = rec({ expiryHeight: 0 });
    expect(asOfTip(input, TIP + 5000)).toBe(input);
  });

  test("a confirmed record is unchanged past its expiry", () => {
    const input = confirmed({ expiryHeight: 160 });
    expect(asOfTip(input, 500)).toBe(input);
  });

  test("it never changes the record it is given", () => {
    const input = Object.freeze(rec({ expiryHeight: 160 }));
    const before = structuredClone(input);
    asOfTip(input, 200);
    expect(input).toEqual(before);
  });
});
