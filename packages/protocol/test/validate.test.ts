import { describe, expect, it } from "vitest";
import {
  DEPOSIT_INDEX_RE,
  isValidPayTo,
  MAX_MONEY_ZAT,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  ProtocolError,
  parseZat,
  SESSION_KEY_RE,
  SIG_RE,
  TXID_RE,
  ZAT_RE,
} from "../src/index.js";

const TESTNET_FIXTURE =
  "utest1q97m3j4x8x3mfw52ye4r8nx9ye7nuyt54ra0qnf79h2j0v76dqvl2arf9955zk620sjhe3954kc6x364r8rgn4xa6l7nwyr9nyqua6f9";
const BODY = "q".repeat(60);

// HRPs from zcash_address 0.14.0 src/constants.rs: HRP_UNIFIED_ADDRESS (R0),
// HRP_UNIFIED_ADDRESS_R2 (shielded-only), HRP_UNIFIED_ADDRESS_R2_TI (transparent-including).
const NETWORKS = [
  { network: NETWORK_TESTNET, r0: "utest1", shieldedOnly: "zutest1", transparentIncluding: "tutest1" },
  { network: NETWORK_REGTEST, r0: "uregtest1", shieldedOnly: "zuregtest1", transparentIncluding: "turegtest1" },
  { network: NETWORK_MAINNET, r0: "u1", shieldedOnly: "zu1", transparentIncluding: "tu1" },
] as const;

function protocolError(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return e as ProtocolError;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

describe("parseZat", () => {
  it("accepts canonical decimals", () => {
    expect(parseZat("0")).toBe(0n);
    expect(parseZat("1000")).toBe(1000n);
    expect(parseZat("2100000000000000")).toBe(MAX_MONEY_ZAT);
  });

  it.each(["01", "+1", "1.0", "", "1e3", "2100000000000001"])(
    "rejects non-canonical input %j",
    (input) => {
      expect(protocolError(() => parseZat(input)).code).toBe("invalid_payload");
    },
  );
});

describe("isValidPayTo", () => {
  it("accepts the testnet fixture on zcash:testnet only", () => {
    expect(isValidPayTo(TESTNET_FIXTURE, NETWORK_TESTNET)).toBe(true);
    expect(isValidPayTo(TESTNET_FIXTURE, NETWORK_REGTEST)).toBe(false);
    expect(isValidPayTo(TESTNET_FIXTURE, NETWORK_MAINNET)).toBe(false);
  });

  describe.each(NETWORKS)("$network", ({ network, r0, shieldedOnly, transparentIncluding }) => {
    it("accepts the R0 unified-address HRP", () => {
      expect(isValidPayTo(r0 + BODY, network)).toBe(true);
    });

    it("accepts the shielded-only R2 HRP", () => {
      expect(isValidPayTo(shieldedOnly + BODY, network)).toBe(true);
    });

    it("rejects the transparent-including R2 HRP", () => {
      expect(isValidPayTo(transparentIncluding + BODY, network)).toBe(false);
    });

    it("rejects uppercase, a b in the body, and a bare HRP", () => {
      expect(isValidPayTo((shieldedOnly + BODY).toUpperCase(), network)).toBe(false);
      expect(isValidPayTo(`${shieldedOnly}${BODY}b`, network)).toBe(false);
      expect(isValidPayTo(shieldedOnly, network)).toBe(false);
      expect(isValidPayTo(r0, network)).toBe(false);
      expect(isValidPayTo(`${shieldedOnly}${BODY}\n`, network)).toBe(false);
    });

    it("accepts the shielded-only prefix on its own network only", () => {
      for (const other of NETWORKS) {
        expect(isValidPayTo(shieldedOnly + BODY, other.network)).toBe(other.network === network);
      }
    });
  });

  it("rejects an unknown network", () => {
    expect(isValidPayTo(TESTNET_FIXTURE, "eip155:1")).toBe(false);
    expect(isValidPayTo("u1" + BODY, "")).toBe(false);
  });
});

describe("wire regexes", () => {
  it("SESSION_KEY_RE accepts 64 lowercase hex and rejects uppercase and 63 characters", () => {
    expect(SESSION_KEY_RE.test("0123456789abcdef".repeat(4))).toBe(true);
    expect(SESSION_KEY_RE.test("0123456789ABCDEF".repeat(4))).toBe(false);
    expect(SESSION_KEY_RE.test("a".repeat(63))).toBe(false);
    expect(SESSION_KEY_RE.test("a".repeat(65))).toBe(false);
  });

  it("TXID_RE is 64 lowercase hex", () => {
    expect(TXID_RE.test("ab".repeat(32))).toBe(true);
    expect(TXID_RE.test("AB".repeat(32))).toBe(false);
    expect(TXID_RE.test("ab".repeat(31))).toBe(false);
  });

  it("SIG_RE is 128 lowercase hex", () => {
    expect(SIG_RE.test("ab".repeat(64))).toBe(true);
    expect(SIG_RE.test("aB".repeat(64))).toBe(false);
    expect(SIG_RE.test("ab".repeat(63))).toBe(false);
  });

  it("ZAT_RE is a canonical decimal of at most 16 digits", () => {
    for (const ok of ["0", "7", "1000", "9999999999999999"]) expect(ZAT_RE.test(ok)).toBe(true);
    for (const bad of ["", "00", "01", "-1", "+1", "1.0", "10000000000000000"]) expect(ZAT_RE.test(bad)).toBe(false);
  });

  it("DEPOSIT_INDEX_RE is a canonical decimal of at most 9 digits", () => {
    for (const ok of ["0", "1", "42", "999999999"]) expect(DEPOSIT_INDEX_RE.test(ok)).toBe(true);
    for (const bad of ["", "01", "-1", "1000000000", "1.5"]) expect(DEPOSIT_INDEX_RE.test(bad)).toBe(false);
  });
});
