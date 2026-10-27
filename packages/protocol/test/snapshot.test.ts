import { describe, expect, it } from "vitest";
import { MAX_MONEY_ZAT, parseSessionSnapshot, type SessionSnapshot } from "../src/index.js";

const KEY = "ab".repeat(32);
const TXID = "cd".repeat(32);

function example(): Record<string, unknown> {
  return {
    sessionKey: KEY,
    cumulativeZat: "53000",
    limitZat: "125000",
    headroomZat: "72000",
    confirmedZat: "100000",
    pendingZat: "0",
    creditZat: "25000",
    tip: 4547331,
    deposits: [
      { txid: TXID, valueZat: "100000", status: "confirmed", confirmations: 2, expiryHeight: 4547450, zeroConf: true },
    ],
  };
}

function withDeposit(patch: Record<string, unknown>): Record<string, unknown> {
  const s = example();
  s.deposits = [{ ...(s.deposits as Array<Record<string, unknown>>)[0], ...patch }];
  return s;
}

describe("parseSessionSnapshot", () => {
  it("accepts the protocol.md section 7.2 example", () => {
    const parsed = parseSessionSnapshot(example());
    expect(parsed).toEqual(example() as unknown as SessionSnapshot);
  });

  it("accepts every deposit status", () => {
    for (const status of ["pending", "confirmed", "final", "orphaned", "dead"]) {
      expect(parseSessionSnapshot(withDeposit({ status }))).not.toBeNull();
    }
  });

  it("accepts an empty deposit list and a zero tip", () => {
    expect(parseSessionSnapshot({ ...example(), deposits: [], tip: 0 })).not.toBeNull();
  });

  it("round-trips through JSON", () => {
    const parsed = parseSessionSnapshot(JSON.parse(JSON.stringify(example())));
    expect(parsed).toEqual(example());
  });

  it("returns a copy and drops unknown keys", () => {
    const input: Record<string, unknown> = { ...example(), extraTop: 1 };
    const inputDeposits = input.deposits as Array<Record<string, unknown>>;
    inputDeposits[0]!.extraDeposit = "x";
    const parsed = parseSessionSnapshot(input)!;
    expect(parsed).toEqual(example());
    expect(parsed).not.toBe(input);
    expect(parsed.deposits).not.toBe(inputDeposits);
    expect(parsed.deposits[0]).not.toBe(inputDeposits[0]);
  });

  it("returns null for a numeric amount", () => {
    expect(parseSessionSnapshot({ ...example(), limitZat: 125000 })).toBeNull();
  });

  it("returns null for an unknown status", () => {
    expect(parseSessionSnapshot(withDeposit({ status: "weird" }))).toBeNull();
  });

  it("returns null when deposits is missing or not an array", () => {
    const { deposits: _deposits, ...rest } = example();
    expect(parseSessionSnapshot(rest)).toBeNull();
    expect(parseSessionSnapshot({ ...example(), deposits: {} })).toBeNull();
  });

  it("returns null for a string tip", () => {
    expect(parseSessionSnapshot({ ...example(), tip: "1" })).toBeNull();
  });

  it("returns null for an uppercase txid", () => {
    expect(parseSessionSnapshot(withDeposit({ txid: "CD".repeat(32) }))).toBeNull();
  });

  it("returns null for a bad session key", () => {
    expect(parseSessionSnapshot({ ...example(), sessionKey: "AB".repeat(32) })).toBeNull();
    expect(parseSessionSnapshot({ ...example(), sessionKey: "ab" })).toBeNull();
  });

  it("returns null for non-canonical or out-of-range zat strings in every amount field", () => {
    for (const field of ["cumulativeZat", "limitZat", "headroomZat", "confirmedZat", "pendingZat", "creditZat"]) {
      for (const bad of ["01", "-1", "1.5", "", " 1", (MAX_MONEY_ZAT + 1n).toString()]) {
        expect(parseSessionSnapshot({ ...example(), [field]: bad }), `${field}=${bad}`).toBeNull();
      }
    }
    expect(parseSessionSnapshot(withDeposit({ valueZat: "007" }))).toBeNull();
    expect(parseSessionSnapshot(withDeposit({ valueZat: 100000 }))).toBeNull();
  });

  it("accepts MAX_MONEY_ZAT exactly", () => {
    expect(parseSessionSnapshot({ ...example(), limitZat: MAX_MONEY_ZAT.toString() })).not.toBeNull();
  });

  it("returns null for bad numeric fields", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
      expect(parseSessionSnapshot({ ...example(), tip: bad }), `tip=${String(bad)}`).toBeNull();
      expect(parseSessionSnapshot(withDeposit({ confirmations: bad })), `confirmations=${String(bad)}`).toBeNull();
      expect(parseSessionSnapshot(withDeposit({ expiryHeight: bad })), `expiryHeight=${String(bad)}`).toBeNull();
    }
  });

  it("returns null for a non-boolean zeroConf", () => {
    expect(parseSessionSnapshot(withDeposit({ zeroConf: "true" }))).toBeNull();
    expect(parseSessionSnapshot(withDeposit({ zeroConf: 1 }))).toBeNull();
  });

  it("returns null for a missing field", () => {
    for (const field of Object.keys(example())) {
      const s = example();
      delete s[field];
      expect(parseSessionSnapshot(s), field).toBeNull();
    }
    for (const field of Object.keys((example().deposits as Array<Record<string, unknown>>)[0]!)) {
      const s = example();
      delete (s.deposits as Array<Record<string, unknown>>)[0]![field];
      expect(parseSessionSnapshot(s), `deposit.${field}`).toBeNull();
    }
  });

  it("returns null when any deposit in the list is bad", () => {
    const s = example();
    s.deposits = [...(s.deposits as unknown[]), null];
    expect(parseSessionSnapshot(s)).toBeNull();
  });

  it("returns null for non-objects, never throwing", () => {
    for (const x of [null, undefined, 1, "x", true, [], [example()], () => 0, Symbol("s")]) {
      expect(parseSessionSnapshot(x)).toBeNull();
    }
  });

  it("ignores inherited properties", () => {
    const proto = example();
    const inherited = Object.create(proto) as unknown;
    expect(parseSessionSnapshot(inherited)).toBeNull();
    const s = example();
    s.deposits = [Object.create((s.deposits as unknown[])[0] as object)];
    expect(parseSessionSnapshot(s)).toBeNull();
  });

  it("does not throw on a hostile getter or proxy", () => {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(parseSessionSnapshot(hostile)).toBeNull();
  });

  it("is not fooled by __proto__ keys", () => {
    const s = JSON.parse(`{"__proto__":{"x":1},"sessionKey":"${KEY}"}`) as unknown;
    expect(parseSessionSnapshot(s)).toBeNull();
  });
});
