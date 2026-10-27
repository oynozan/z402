import { DEMO_TERMS, parseSessionSnapshot, type DepositStatus } from "@z402/protocol";
import { describe, expect, test } from "vitest";
import { buildSnapshot } from "../../src/core/snapshot.js";
import type { DepositRecord } from "../../src/core/types.js";
import { record, SESSION_KEY, TIP, txidOf, W } from "./records.js";

function dep(status: DepositStatus, valueZat: bigint, over: Partial<DepositRecord> = {}): DepositRecord {
  const mined = status === "confirmed" || status === "final";
  return record({
    status,
    valueZat,
    minedHeight: mined ? TIP - 1 : null,
    confirmations: status === "final" ? 10 : mined ? 2 : 0,
    deadAtTip: status === "dead" ? TIP - 3 : null,
    ...over,
  });
}
const p = (v: bigint) => dep("pending", v);
const c = (v: bigint) => dep("confirmed", v);
const f = (v: bigint) => dep("final", v);
const o = (v: bigint) => dep("orphaned", v);
const d = (v: bigint) => dep("dead", v);

const snap = (deposits: DepositRecord[], cumulativeZat = 0n, tip = TIP) =>
  buildSnapshot({ sessionKey: SESSION_KEY, cumulativeZat, deposits, terms: DEMO_TERMS, tip });

describe("buildSnapshot limit", () => {
  test.each([
    ["new session", [], "0"],
    ["D1 pending", [p(W)], "100000"],
    ["D1 confirmed", [c(W)], "125000"],
    ["D1 confirmed + D2 pending", [c(W), p(W)], "225000"],
    ["D1, D2 confirmed", [c(W), c(W)], "250000"],
    ["D1, D2 both pending", [p(W), p(W)], "100000"],
    ["8 confirmed", Array.from({ length: 8 }, () => c(W)), "1000000"],
    ["9 confirmed", Array.from({ length: 9 }, () => c(W)), "1100000"],
    ["100001 confirmed", [c(100001n)], "125001"],
    ["over-deposit pending", [p(1000000n)], "100000"],
    ["orphaned and dead count nowhere", [o(W), d(W)], "0"],
    ["final counts as confirmed", [f(W)], "125000"],
  ])("%s → limit %s", (_name, deposits, limit) => {
    expect(snap(deposits).limitZat).toBe(limit);
  });

  test("a pending deposit without zero-conf earns no limit", () => {
    expect(snap([dep("pending", W, { zeroConf: false })]).limitZat).toBe("0");
  });

  test("the limit is split into its parts", () => {
    expect(snap([c(W), p(W)])).toMatchObject({
      confirmedZat: "100000",
      pendingZat: "100000",
      creditZat: "25000",
      limitZat: "225000",
    });
  });
});

describe("buildSnapshot headroom", () => {
  test("headroom is the limit minus the settled cumulative", () => {
    expect(snap([c(W)], 53000n).headroomZat).toBe("72000");
  });

  test("headroom never negative", () => {
    expect(snap([c(W)], 200000n).headroomZat).toBe("0");
  });

  test("headroom is 0 exactly at the limit", () => {
    expect(snap([c(W)], 125000n).headroomZat).toBe("0");
  });
});

describe("buildSnapshot fields", () => {
  test("matches the example of protocol.md section 7.2", () => {
    const deposit = record({
      txid: txidOf(0xcd),
      valueZat: 100000n,
      zeroConf: true,
      expiryHeight: 4547450,
      firstSeenTip: 4547329,
      status: "confirmed",
      minedHeight: 4547330,
      confirmations: 2,
    });
    expect(snap([deposit], 53000n, 4547331)).toEqual({
      sessionKey: SESSION_KEY,
      cumulativeZat: "53000",
      limitZat: "125000",
      headroomZat: "72000",
      confirmedZat: "100000",
      pendingZat: "0",
      creditZat: "25000",
      tip: 4547331,
      deposits: [
        {
          txid: txidOf(0xcd),
          valueZat: "100000",
          status: "confirmed",
          confirmations: 2,
          expiryHeight: 4547450,
          zeroConf: true,
        },
      ],
    });
  });

  test("every status is listed with its own confirmations", () => {
    const deposits = [
      dep("pending", 1n),
      dep("confirmed", 2n, { confirmations: 7 }),
      dep("final", 3n, { confirmations: 12 }),
      dep("orphaned", 4n),
      dep("dead", 5n),
    ];
    expect(snap(deposits).deposits.map((x) => [x.status, x.valueZat, x.confirmations])).toEqual([
      ["pending", "1", 0],
      ["confirmed", "2", 7],
      ["final", "3", 12],
      ["orphaned", "4", 0],
      ["dead", "5", 0],
    ]);
  });
});

describe("buildSnapshot deposit list", () => {
  test("deposits list keeps non-final + last 4 final", () => {
    const deposits = [...Array.from({ length: 30 }, () => f(W)), p(W)];
    expect(snap(deposits).deposits).toHaveLength(5);
  });

  test("the kept final deposits are the latest ones and the order is insertion order", () => {
    const at = (n: number, status: DepositStatus) => dep(status, W, { txid: txidOf(n) });
    const deposits = [
      at(1, "final"),
      at(2, "final"),
      at(3, "pending"),
      at(4, "final"),
      at(5, "confirmed"),
      at(6, "final"),
      at(7, "final"),
      at(8, "dead"),
      at(9, "final"),
      at(10, "orphaned"),
      at(11, "final"),
    ];
    expect(snap(deposits).deposits.map((x) => x.txid)).toEqual([3, 5, 6, 7, 8, 9, 10, 11].map(txidOf));
  });

  test("fewer than four final deposits are all kept", () => {
    const deposits = [f(W), p(W), f(W)];
    expect(snap(deposits).deposits).toHaveLength(3);
  });

  test("final deposits still count toward the limit when they are not listed", () => {
    const deposits = Array.from({ length: 30 }, () => f(W));
    expect(snap(deposits)).toMatchObject({ confirmedZat: "3000000", limitZat: "3200000" });
    expect(snap(deposits).deposits).toHaveLength(4);
  });
});

describe("buildSnapshot wire format", () => {
  test("snapshot round-trips through parseSessionSnapshot and stays small", () => {
    const s = snap([...Array.from({ length: 30 }, () => f(W)), p(W)], 500n);
    expect(parseSessionSnapshot(s)).toEqual(s);
    expect(Buffer.from(JSON.stringify(s)).toString("base64").length).toBeLessThan(4096);
  });

  test("amounts are strings and heights are numbers", () => {
    const s = snap([c(W)], 500n);
    expect(typeof s.cumulativeZat).toBe("string");
    expect(typeof s.tip).toBe("number");
    expect(s.deposits[0]).toMatchObject({ valueZat: "100000", confirmations: 2, expiryHeight: TIP + 40 });
  });

  test("records are not leaked into the listed deposits", () => {
    expect(Object.keys(snap([c(W)]).deposits[0] ?? {}).sort()).toEqual([
      "confirmations",
      "expiryHeight",
      "status",
      "txid",
      "valueZat",
      "zeroConf",
    ]);
  });
});
