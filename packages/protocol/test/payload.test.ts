import { describe, expect, it } from "vitest";
import { MAX_MONEY_ZAT, parseVoucherPayload, ProtocolError, REASON } from "../src/index.js";

function protocolError(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

// The protocol.md section 3 example.
const EXAMPLE = {
  sessionKey: "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
  cumulativeZat: "53000",
  sig: "a".repeat(128),
  depositTxid: "b".repeat(64),
};

describe("parseVoucherPayload", () => {
  it("accepts the protocol.md section 3 example", () => {
    expect(parseVoucherPayload(EXAMPLE)).toEqual(EXAMPLE);
  });

  it("accepts the example after a JSON hop", () => {
    expect(parseVoucherPayload(JSON.parse(JSON.stringify(EXAMPLE)))).toEqual(EXAMPLE);
  });

  it("returns a fresh object", () => {
    const input = { ...EXAMPLE };
    expect(parseVoucherPayload(input)).not.toBe(input);
  });

  it("returns only the four known keys, even with an unknown key present", () => {
    const out = parseVoucherPayload({ ...EXAMPLE, extra: 1 });
    expect(out).toEqual(EXAMPLE);
    expect(Object.keys(out).sort()).toEqual(["cumulativeZat", "depositTxid", "sessionKey", "sig"]);
  });

  it("omits depositTxid when it is absent", () => {
    const { depositTxid: _txid, ...withoutTxid } = EXAMPLE;
    const out = parseVoucherPayload(withoutTxid);
    expect(out).toEqual(withoutTxid);
    expect(Object.keys(out).sort()).toEqual(["cumulativeZat", "sessionKey", "sig"]);
    expect("depositTxid" in out).toBe(false);
  });

  it("omits depositTxid when it is explicitly undefined", () => {
    const out = parseVoucherPayload({ ...EXAMPLE, depositTxid: undefined });
    expect("depositTxid" in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(["cumulativeZat", "sessionKey", "sig"]);
  });

  it("returns cumulativeZat as the original string", () => {
    const max = MAX_MONEY_ZAT.toString();
    expect(parseVoucherPayload({ ...EXAMPLE, cumulativeZat: max }).cumulativeZat).toBe(max);
    expect(parseVoucherPayload({ ...EXAMPLE, cumulativeZat: "0" }).cumulativeZat).toBe("0");
    expect(typeof parseVoucherPayload(EXAMPLE).cumulativeZat).toBe("string");
  });

  const REJECTED: [string, unknown][] = [
    ["an uppercase sessionKey", { ...EXAMPLE, sessionKey: EXAMPLE.sessionKey.toUpperCase() }],
    ["a 63-character sessionKey", { ...EXAMPLE, sessionKey: EXAMPLE.sessionKey.slice(1) }],
    ["a sessionKey with a trailing newline", { ...EXAMPLE, sessionKey: `${EXAMPLE.sessionKey}\n` }],
    ["a sessionKey array that stringifies to a valid key", { ...EXAMPLE, sessionKey: [EXAMPLE.sessionKey] }],
    ["a missing sessionKey", { cumulativeZat: EXAMPLE.cumulativeZat, sig: EXAMPLE.sig }],
    ["a leading-zero cumulativeZat", { ...EXAMPLE, cumulativeZat: "053000" }],
    ["a signed cumulativeZat", { ...EXAMPLE, cumulativeZat: "+53000" }],
    ["an empty cumulativeZat", { ...EXAMPLE, cumulativeZat: "" }],
    ["a cumulativeZat above MAX_MONEY", { ...EXAMPLE, cumulativeZat: (MAX_MONEY_ZAT + 1n).toString() }],
    ["a numeric cumulativeZat", { ...EXAMPLE, cumulativeZat: 53000 }],
    ["a bigint cumulativeZat", { ...EXAMPLE, cumulativeZat: 53000n }],
    ["a missing cumulativeZat", { sessionKey: EXAMPLE.sessionKey, sig: EXAMPLE.sig }],
    ["a 127-character sig", { ...EXAMPLE, sig: "a".repeat(127) }],
    ["a 129-character sig", { ...EXAMPLE, sig: "a".repeat(129) }],
    ["an uppercase sig", { ...EXAMPLE, sig: "A".repeat(128) }],
    ["a missing sig", { sessionKey: EXAMPLE.sessionKey, cumulativeZat: EXAMPLE.cumulativeZat }],
    ["an uppercase depositTxid", { ...EXAMPLE, depositTxid: "B".repeat(64) }],
    ["a 63-character depositTxid", { ...EXAMPLE, depositTxid: "b".repeat(63) }],
    ["a null depositTxid", { ...EXAMPLE, depositTxid: null }],
    ["a numeric depositTxid", { ...EXAMPLE, depositTxid: 1 }],
    ["null", null],
    ["undefined", undefined],
    ["a string", JSON.stringify(EXAMPLE)],
    ["a number", 53000],
    ["an array", [EXAMPLE]],
    ["an empty object", {}],
  ];

  it.each(REJECTED)("throws invalid_payload for %s", (_name, input) => {
    expect(protocolError(() => parseVoucherPayload(input)).code).toBe(REASON.invalidPayload);
  });
});
