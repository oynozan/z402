import { describe, expect, it } from "vitest";
import {
  DEMO_TERMS,
  encodeTerms,
  MAX_MONEY_ZAT,
  parseTerms,
  ProtocolError,
  REASON,
  type Terms,
} from "../src/index.js";

function protocolError(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

const WIRE = { windowZat: "100000", creditRatioBps: 2500, creditCapZat: "200000", zeroConfMinExpiryBlocks: 20 };

describe("DEMO_TERMS", () => {
  it("holds the protocol.md section 12 values", () => {
    expect(DEMO_TERMS).toEqual({
      windowZat: 100000n,
      creditRatioBps: 2500,
      creditCapZat: 200000n,
      zeroConfMinExpiryBlocks: 20,
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DEMO_TERMS)).toBe(true);
  });
});

describe("encodeTerms", () => {
  it("serializes amounts as decimal strings", () => {
    expect(encodeTerms(DEMO_TERMS)).toEqual(WIRE);
  });

  it("returns a fresh object holding exactly the four wire keys", () => {
    const a = encodeTerms(DEMO_TERMS);
    const b = encodeTerms(DEMO_TERMS);
    expect(a).not.toBe(b);
    expect(Object.keys(a).sort()).toEqual(["creditCapZat", "creditRatioBps", "windowZat", "zeroConfMinExpiryBlocks"]);
  });
});

describe("parseTerms", () => {
  it("round-trips encodeTerms(DEMO_TERMS)", () => {
    expect(parseTerms(encodeTerms(DEMO_TERMS))).toEqual(DEMO_TERMS);
  });

  it("round-trips after a JSON hop", () => {
    expect(parseTerms(JSON.parse(JSON.stringify(encodeTerms(DEMO_TERMS))))).toEqual(DEMO_TERMS);
  });

  it("returns a new object and does not freeze or alias the input", () => {
    const input = { ...WIRE };
    const out = parseTerms(input);
    expect(out).not.toBe(DEMO_TERMS);
    expect(Object.isFrozen(out)).toBe(false);
    expect(input).toEqual(WIRE);
  });

  it("ignores termsVersion", () => {
    expect(parseTerms({ ...WIRE, termsVersion: "0123456789abcdef" })).toEqual(DEMO_TERMS);
  });

  it("ignores every unknown key, including a malformed termsVersion", () => {
    const out = parseTerms({ ...WIRE, termsVersion: 7, paymentFlow: "x", creditRatio: 0.5, extra: null });
    expect(out).toEqual(DEMO_TERMS);
    expect(Object.keys(out).sort()).toEqual(["creditCapZat", "creditRatioBps", "windowZat", "zeroConfMinExpiryBlocks"]);
  });

  it("accepts the boundary values", () => {
    const edge: Terms = { windowZat: 1n, creditRatioBps: 0, creditCapZat: 0n, zeroConfMinExpiryBlocks: 0 };
    expect(parseTerms(encodeTerms(edge))).toEqual(edge);
    expect(parseTerms({ ...WIRE, creditRatioBps: 10000 }).creditRatioBps).toBe(10000);
    expect(parseTerms({ ...WIRE, windowZat: MAX_MONEY_ZAT.toString() }).windowZat).toBe(MAX_MONEY_ZAT);
  });

  const { creditRatioBps: _bps, ...WITHOUT_BPS } = WIRE;
  const { zeroConfMinExpiryBlocks: _blocks, ...WITHOUT_BLOCKS } = WIRE;
  const { windowZat: _window, ...WITHOUT_WINDOW } = WIRE;
  const { creditCapZat: _cap, ...WITHOUT_CAP } = WIRE;

  const REJECTED: [string, unknown][] = [
    ["creditRatio float without creditRatioBps", { ...WITHOUT_BPS, creditRatio: 0.25 }],
    ["missing creditRatioBps", WITHOUT_BPS],
    ["fractional creditRatioBps", { ...WIRE, creditRatioBps: 2500.5 }],
    ["creditRatioBps above 10000", { ...WIRE, creditRatioBps: 10001 }],
    ["negative creditRatioBps", { ...WIRE, creditRatioBps: -1 }],
    ["NaN creditRatioBps", { ...WIRE, creditRatioBps: Number.NaN }],
    ["Infinity creditRatioBps", { ...WIRE, creditRatioBps: Number.POSITIVE_INFINITY }],
    ["string creditRatioBps", { ...WIRE, creditRatioBps: "2500" }],
    ["bigint creditRatioBps", { ...WIRE, creditRatioBps: 2500n }],
    ["windowZat as a number", { ...WIRE, windowZat: 100000 }],
    ["windowZat as a bigint", { ...WIRE, windowZat: 100000n }],
    ["zero windowZat", { ...WIRE, windowZat: "0" }],
    ["leading-zero windowZat", { ...WIRE, windowZat: "0100000" }],
    ["signed windowZat", { ...WIRE, windowZat: "+100000" }],
    ["windowZat above MAX_MONEY", { ...WIRE, windowZat: (MAX_MONEY_ZAT + 1n).toString() }],
    ["missing windowZat", WITHOUT_WINDOW],
    ["creditCapZat as a number", { ...WIRE, creditCapZat: 200000 }],
    ["leading-zero creditCapZat", { ...WIRE, creditCapZat: "0200000" }],
    ["negative creditCapZat", { ...WIRE, creditCapZat: "-1" }],
    ["creditCapZat above MAX_MONEY", { ...WIRE, creditCapZat: (MAX_MONEY_ZAT + 1n).toString() }],
    ["missing creditCapZat", WITHOUT_CAP],
    ["missing zeroConfMinExpiryBlocks", WITHOUT_BLOCKS],
    ["negative zeroConfMinExpiryBlocks", { ...WIRE, zeroConfMinExpiryBlocks: -1 }],
    ["fractional zeroConfMinExpiryBlocks", { ...WIRE, zeroConfMinExpiryBlocks: 20.5 }],
    ["string zeroConfMinExpiryBlocks", { ...WIRE, zeroConfMinExpiryBlocks: "20" }],
    ["NaN zeroConfMinExpiryBlocks", { ...WIRE, zeroConfMinExpiryBlocks: Number.NaN }],
    ["null", null],
    ["undefined", undefined],
    ["a string", JSON.stringify(WIRE)],
    ["a number", 7],
    ["an array", [WIRE]],
    ["an empty object", {}],
  ];

  it.each(REJECTED)("throws invalid_payment_requirements for %s", (_name, input) => {
    expect(protocolError(() => parseTerms(input)).code).toBe(REASON.invalidPaymentRequirements);
  });
});
