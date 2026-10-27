import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { describe, expect, it } from "vitest";
import {
  generateSeed,
  MAX_MONEY_ZAT,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  ProtocolError,
  publicKeyFromSeed,
  REASON,
  signVoucher,
  type VoucherFields,
  verifyVoucher,
  voucherMessage,
} from "../src/index.js";

interface Vectors {
  seed: string;
  sessionKey: string;
  payTo: string;
  scheme: string;
  network: string;
  cases: { cumulativeZat: string; messageHex: string; sig: string }[];
}

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as Vectors;
const seed = hexToBytes(vectors.seed);
const ctx = { scheme: vectors.scheme, network: vectors.network, payTo: vectors.payTo };
const [CASE_1000, CASE_53000] = vectors.cases;
if (!CASE_1000 || !CASE_53000) throw new Error("vectors.json must hold the 1000 and 53000 cases");

const OTHER_TESTNET_PAY_TO = `utest1${"q".repeat(60)}`;
const REGTEST_PAY_TO = `uregtest1${"q".repeat(60)}`;
const MAINNET_PAY_TO = `u1${"q".repeat(60)}`;
const FF_SESSION_KEY = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(0xff)));
const ED25519_ORDER_L = 2n ** 252n + 27742317777372353535851937790883648493n;

function fieldsFor(cumulativeZat: string): VoucherFields {
  return { ...ctx, sessionKey: vectors.sessionKey, cumulativeZat };
}

function payloadFor(c: { cumulativeZat: string; sig: string }) {
  return { sessionKey: vectors.sessionKey, cumulativeZat: c.cumulativeZat, sig: c.sig };
}

function protocolError(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

function flipLastHexDigit(hex: string): string {
  const last = hex.at(-1) === "0" ? "1" : "0";
  return hex.slice(0, -1) + last;
}

describe("vectors.json", () => {
  it("pins the seed, the session key and the two cases", () => {
    expect(vectors.seed).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(vectors.sessionKey).toBe("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
    expect(vectors.scheme).toBe("prepaid-voucher");
    expect(vectors.network).toBe(NETWORK_TESTNET);
    expect(vectors.cases.map((c) => c.cumulativeZat)).toEqual(["1000", "53000"]);
  });
});

describe("publicKeyFromSeed", () => {
  it("matches the vector sessionKey", () => {
    expect(publicKeyFromSeed(seed)).toBe(vectors.sessionKey);
  });

  it("rejects a seed that is not 32 bytes", () => {
    expect(() => publicKeyFromSeed(new Uint8Array(31))).toThrow(RangeError);
    expect(() => publicKeyFromSeed(new Uint8Array(33))).toThrow(RangeError);
  });
});

describe("voucherMessage", () => {
  it.each(vectors.cases)("bytes equal the vector messageHex for cumulativeZat $cumulativeZat", (c) => {
    const msg = voucherMessage(fieldsFor(c.cumulativeZat));
    expect(msg).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(msg).toString("hex")).toBe(c.messageHex);
  });

  it("is the UTF-8 of the newline-joined fields", () => {
    const text = new TextDecoder().decode(voucherMessage(fieldsFor("1000")));
    expect(text).toBe(
      `z402-voucher-v1\nprepaid-voucher\nzcash:testnet\n${vectors.payTo}\n${vectors.sessionKey}\n1000`,
    );
  });

  it("accepts network zcash:regtest with a regtest payTo", () => {
    const f = { ...fieldsFor("1000"), network: NETWORK_REGTEST, payTo: REGTEST_PAY_TO };
    const text = new TextDecoder().decode(voucherMessage(f));
    expect(text).toBe(
      `z402-voucher-v1\nprepaid-voucher\nzcash:regtest\n${REGTEST_PAY_TO}\n${vectors.sessionKey}\n1000`,
    );
  });

  it("rejects a regtest payTo under network zcash:testnet", () => {
    const f = { ...fieldsFor("1000"), payTo: REGTEST_PAY_TO };
    expect(protocolError(() => voucherMessage(f)).code).toBe(REASON.invalidPayload);
  });

  it("accepts the mainnet network with a mainnet payTo", () => {
    const f = { ...fieldsFor("1000"), network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO };
    expect(() => voucherMessage(f)).not.toThrow();
  });

  it("accepts cumulativeZat 0 and exactly MAX_MONEY", () => {
    expect(() => voucherMessage(fieldsFor("0"))).not.toThrow();
    expect(() => voucherMessage(fieldsFor(MAX_MONEY_ZAT.toString()))).not.toThrow();
  });

  const BAD: [keyof VoucherFields, string][] = [
    ["scheme", "prepaid\nvoucher"],
    ["scheme", "Prepaid-Voucher"],
    ["scheme", ""],
    ["scheme", "a".repeat(65)],
    ["network", "zcash:testnet\n"],
    ["network", "zcash:unknown"],
    ["network", "ZCASH:TESTNET"],
    ["network", ""],
    ["payTo", `${vectors.payTo}\n`],
    ["payTo", `\n${vectors.payTo}`],
    ["payTo", `${vectors.payTo.slice(0, 20)}\n${vectors.payTo.slice(20)}`],
    ["payTo", "tutest1qqqqqqqqqqqq"],
    ["payTo", vectors.payTo.toUpperCase()],
    ["payTo", ""],
    ["sessionKey", `${vectors.sessionKey}\n`],
    ["sessionKey", vectors.sessionKey.toUpperCase()],
    ["sessionKey", vectors.sessionKey.slice(1)],
    ["sessionKey", `${vectors.sessionKey}0`],
    ["sessionKey", `g${vectors.sessionKey.slice(1)}`],
    ["cumulativeZat", "1000\n"],
    ["cumulativeZat", "10\n00"],
    ["cumulativeZat", "01000"],
    ["cumulativeZat", "-1"],
    ["cumulativeZat", "1.5"],
    ["cumulativeZat", "1e3"],
    ["cumulativeZat", " 1000"],
    ["cumulativeZat", ""],
    ["cumulativeZat", (MAX_MONEY_ZAT + 1n).toString()],
    ["cumulativeZat", "9999999999999999"],
  ];

  it.each(BAD)("throws ProtocolError(invalid_payload) for %s = %j", (field, value) => {
    const err = protocolError(() => voucherMessage({ ...fieldsFor("1000"), [field]: value }));
    expect(err.code).toBe(REASON.invalidPayload);
  });

  it("throws ProtocolError(invalid_payload) for a non-string field", () => {
    for (const field of ["scheme", "network", "payTo", "sessionKey", "cumulativeZat"] as const) {
      const f = { ...fieldsFor("1000"), [field]: 1000 } as unknown as VoucherFields;
      expect(protocolError(() => voucherMessage(f)).code).toBe(REASON.invalidPayload);
    }
  });
});

describe("signVoucher", () => {
  it.each(vectors.cases)("reproduces the vector sig for cumulativeZat $cumulativeZat", (c) => {
    expect(signVoucher(seed, fieldsFor(c.cumulativeZat))).toBe(c.sig);
  });

  it("refuses to sign fields that fail validation", () => {
    const f = { ...fieldsFor("1000"), cumulativeZat: "1000\n" };
    expect(protocolError(() => signVoucher(seed, f)).code).toBe(REASON.invalidPayload);
  });

  it("rejects a seed that is not 32 bytes", () => {
    expect(() => signVoucher(new Uint8Array(16), fieldsFor("1000"))).toThrow(RangeError);
  });
});

describe("verifyVoucher", () => {
  it.each(vectors.cases)("accepts the vector for cumulativeZat $cumulativeZat", (c) => {
    expect(verifyVoucher(payloadFor(c), ctx)).toBe(true);
  });

  it("rejects cumulativeZat 1001", () => {
    expect(verifyVoucher({ ...payloadFor(CASE_1000), cumulativeZat: "1001" }, ctx)).toBe(false);
  });

  it("rejects the 1000 sig presented for 53000", () => {
    expect(verifyVoucher({ ...payloadFor(CASE_53000), sig: CASE_1000.sig }, ctx)).toBe(false);
  });

  it("rejects another payTo", () => {
    expect(verifyVoucher(payloadFor(CASE_1000), { ...ctx, payTo: OTHER_TESTNET_PAY_TO })).toBe(false);
  });

  it("rejects network zcash:mainnet", () => {
    expect(verifyVoucher(payloadFor(CASE_1000), { ...ctx, network: NETWORK_MAINNET })).toBe(false);
  });

  it("rejects a network and payTo that are valid together but were not signed", () => {
    const other = { ...ctx, network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO };
    expect(() => voucherMessage({ ...other, sessionKey: vectors.sessionKey, cumulativeZat: "1000" })).not.toThrow();
    expect(verifyVoucher(payloadFor(CASE_1000), other)).toBe(false);
  });

  it("rejects another scheme", () => {
    expect(verifyVoucher(payloadFor(CASE_1000), { ...ctx, scheme: "other-scheme" })).toBe(false);
  });

  it("rejects the uppercase sig", () => {
    expect(verifyVoucher({ ...payloadFor(CASE_1000), sig: CASE_1000.sig.toUpperCase() }, ctx)).toBe(false);
  });

  it("rejects the sig with its last hex digit flipped", () => {
    expect(verifyVoucher({ ...payloadFor(CASE_1000), sig: flipLastHexDigit(CASE_1000.sig) }, ctx)).toBe(false);
  });

  it("rejects the sessionKey of seed ff..ff", () => {
    expect(FF_SESSION_KEY).not.toBe(vectors.sessionKey);
    expect(verifyVoucher({ ...payloadFor(CASE_1000), sessionKey: FF_SESSION_KEY }, ctx)).toBe(false);
  });

  it("rejects a malleated signature (S + L)", () => {
    const sig = hexToBytes(CASE_1000.sig);
    const s = BigInt(`0x${bytesToHex(sig.slice(32).reverse())}`) + ED25519_ORDER_L;
    const sBytes = hexToBytes(s.toString(16).padStart(64, "0")).reverse();
    const malleated = bytesToHex(Uint8Array.from([...sig.slice(0, 32), ...sBytes]));
    expect(malleated).not.toBe(CASE_1000.sig);
    expect(verifyVoucher({ ...payloadFor(CASE_1000), sig: malleated }, ctx)).toBe(false);
  });

  it("round-trips a freshly generated key", () => {
    const fresh = generateSeed();
    const sessionKey = publicKeyFromSeed(fresh);
    const f = { ...ctx, sessionKey, cumulativeZat: "7" };
    const sig = signVoucher(fresh, f);
    expect(verifyVoucher({ sessionKey, cumulativeZat: "7", sig }, ctx)).toBe(true);
  });

  describe("never throws on malformed input", () => {
    const good = payloadFor(CASE_1000);
    const BAD_INPUTS: [string, () => boolean][] = [
      ["non-hex sig", () => verifyVoucher({ ...good, sig: "zz".repeat(64) }, ctx)],
      ["short sig", () => verifyVoucher({ ...good, sig: good.sig.slice(2) }, ctx)],
      ["long sig", () => verifyVoucher({ ...good, sig: `${good.sig}00` }, ctx)],
      ["empty sig", () => verifyVoucher({ ...good, sig: "" }, ctx)],
      ["sig with a newline", () => verifyVoucher({ ...good, sig: `${good.sig}\n` }, ctx)],
      ["non-hex sessionKey", () => verifyVoucher({ ...good, sessionKey: "zz".repeat(32) }, ctx)],
      ["short sessionKey", () => verifyVoucher({ ...good, sessionKey: good.sessionKey.slice(2) }, ctx)],
      ["uppercase sessionKey", () => verifyVoucher({ ...good, sessionKey: good.sessionKey.toUpperCase() }, ctx)],
      ["sessionKey that is not a curve point", () => verifyVoucher({ ...good, sessionKey: "ff".repeat(32) }, ctx)],
      ["all-zero sessionKey", () => verifyVoucher({ ...good, sessionKey: "00".repeat(32) }, ctx)],
      ["cumulativeZat with a newline", () => verifyVoucher({ ...good, cumulativeZat: "1000\n" }, ctx)],
      ["non-canonical cumulativeZat", () => verifyVoucher({ ...good, cumulativeZat: "01000" }, ctx)],
      ["cumulativeZat above MAX_MONEY", () => verifyVoucher({ ...good, cumulativeZat: "9999999999999999" }, ctx)],
      ["unknown network", () => verifyVoucher(good, { ...ctx, network: "zcash:nowhere" })],
      ["payTo for another network", () => verifyVoucher(good, { ...ctx, payTo: REGTEST_PAY_TO })],
      ["scheme with a newline", () => verifyVoucher(good, { ...ctx, scheme: "prepaid\nvoucher" })],
      ["undefined sig", () => verifyVoucher({ ...good, sig: undefined } as never, ctx)],
      ["numeric cumulativeZat", () => verifyVoucher({ ...good, cumulativeZat: 1000 } as never, ctx)],
      ["null payload", () => verifyVoucher(null as never, ctx)],
      ["undefined payload", () => verifyVoucher(undefined as never, ctx)],
      ["null context", () => verifyVoucher(good, null as never)],
      ["empty object payload", () => verifyVoucher({} as never, ctx)],
    ];

    it.each(BAD_INPUTS)("returns false for %s", (_name, call) => {
      expect(call()).toBe(false);
    });
  });
});

describe("generateSeed", () => {
  it("returns 32 random bytes as a Uint8Array", () => {
    const a = generateSeed();
    const b = generateSeed();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("noble cross-check", () => {
  it.each(vectors.cases)("ed25519.verify accepts the vector for cumulativeZat $cumulativeZat", (c) => {
    const message = hexToBytes(c.messageHex);
    const pub = hexToBytes(vectors.sessionKey);
    expect(ed25519.verify(hexToBytes(c.sig), message, pub)).toBe(true);
    expect(ed25519.verify(hexToBytes(c.sig), message, pub, { zip215: false })).toBe(true);
  });

  it("noble derives the same sessionKey from the seed", () => {
    expect(bytesToHex(ed25519.getPublicKey(seed))).toBe(vectors.sessionKey);
  });
});
