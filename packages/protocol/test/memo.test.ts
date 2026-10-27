import { describe, expect, it } from "vitest";
import { depositMemo, parseDepositMemo, ProtocolError, REASON } from "../src/index.js";

function protocolError(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

const K = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";

describe("depositMemo", () => {
  it("joins the sessionKey and the index with a colon", () => {
    expect(depositMemo(K, 1)).toBe(`${K}:1`);
    expect(depositMemo(K, 0)).toBe(`${K}:0`);
    expect(depositMemo(K, 999_999_999)).toBe(`${K}:999999999`);
  });

  it.each([
    ["a negative index", K, -1],
    ["an index of 1e9", K, 1e9],
    ["a fractional index", K, 1.5],
    ["NaN", K, Number.NaN],
    ["Infinity", K, Number.POSITIVE_INFINITY],
    ["a string index", K, "1" as unknown as number],
    ["a bigint index", K, 1n as unknown as number],
    ["an uppercase sessionKey", K.toUpperCase(), 1],
    ["a short sessionKey", K.slice(1), 1],
    ["a sessionKey with a trailing colon", `${K}:`, 1],
  ])("throws invalid_payload for %s", (_name, key, index) => {
    expect(protocolError(() => depositMemo(key, index)).code).toBe(REASON.invalidPayload);
  });
});

describe("parseDepositMemo", () => {
  it("round-trips depositMemo", () => {
    expect(parseDepositMemo(depositMemo(K, 7))).toEqual({ sessionKey: K, index: 7 });
    expect(parseDepositMemo(depositMemo(K, 0))).toEqual({ sessionKey: K, index: 0 });
    expect(parseDepositMemo(depositMemo(K, 999_999_999))).toEqual({ sessionKey: K, index: 999_999_999 });
  });

  it("returns the index as a number", () => {
    expect(typeof parseDepositMemo(`${K}:42`)?.index).toBe("number");
  });

  it.each([
    ["a leading zero", `${K}:0123`],
    ["ten digits", `${K}:1234567890`],
    ["an uppercase sessionKey", `${K.toUpperCase()}:1`],
    ["a trailing space", `${K}:1 `],
    ["a leading space", ` ${K}:1`],
    ["a trailing newline", `${K}:1\n`],
    ["a trailing zero byte", `${K}:1\0`],
    ["a negative index", `${K}:-1`],
    ["a signed index", `${K}:+1`],
    ["a decimal index", `${K}:1.0`],
    ["an empty index", `${K}:`],
    ["no index", K],
    ["a 63-character sessionKey", `${K.slice(1)}:1`],
    ["a 65-character sessionKey", `0${K}:1`],
    ["a doubled colon", `${K}::1`],
    ["an empty string", ""],
  ])("returns null for %s", (_name, memo) => {
    expect(parseDepositMemo(memo)).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(parseDepositMemo(undefined as unknown as string)).toBeNull();
    expect(parseDepositMemo(null as unknown as string)).toBeNull();
    expect(parseDepositMemo([`${K}:1`] as unknown as string)).toBeNull();
  });
});
