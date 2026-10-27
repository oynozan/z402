import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isZcashNetwork, VOUCHER_DOMAIN } from "./constants.js";
import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";
import { isValidPayTo, parseZat, SESSION_KEY_RE, SIG_RE } from "./validate.js";

export interface VoucherFields {
  scheme: string;
  network: string;
  payTo: string;
  sessionKey: string;
  cumulativeZat: string;
}

const SCHEME_RE = /^[a-z0-9-]{1,64}$/;

// ASN.1 DER headers for a raw Ed25519 key: PKCS#8 PrivateKeyInfo (seed) and SPKI (public key).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SEED_BYTES = 32;

function invalid(message: string): ProtocolError {
  return new ProtocolError(REASON.invalidPayload, message);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw invalid(`${name} is not a string`);
  return value;
}

function assertSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
    throw new RangeError(`seed must be ${SEED_BYTES} bytes`);
  }
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  assertSeed(seed);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The bytes a voucher signs: UTF-8 of the newline-joined, fully validated fields (protocol.md §4). */
export function voucherMessage(f: VoucherFields): Uint8Array {
  const scheme = requireString(f.scheme, "scheme");
  const network = requireString(f.network, "network");
  const payTo = requireString(f.payTo, "payTo");
  const sessionKey = requireString(f.sessionKey, "sessionKey");
  const cumulativeZat = requireString(f.cumulativeZat, "cumulativeZat");

  if (!SCHEME_RE.test(scheme)) throw invalid("scheme is malformed");
  if (!isZcashNetwork(network)) throw invalid("network is not a known network");
  if (!isValidPayTo(payTo, network)) throw invalid("payTo is not a unified address for the network");
  if (!SESSION_KEY_RE.test(sessionKey)) throw invalid("sessionKey is not 64 lowercase hex");
  parseZat(cumulativeZat);

  return new TextEncoder().encode([VOUCHER_DOMAIN, scheme, network, payTo, sessionKey, cumulativeZat].join("\n"));
}

/** Pure RFC 8032 Ed25519 over `voucherMessage(f)`, as 128 lowercase hex characters. */
export function signVoucher(seed: Uint8Array, f: VoucherFields): string {
  const message = voucherMessage(f);
  return sign(null, message, privateKeyFromSeed(seed)).toString("hex");
}

/**
 * A predicate: true only for a well-formed voucher whose signature verifies under
 * `sessionKey`. Every malformed input, including a field failing validation, yields false.
 */
export function verifyVoucher(
  p: { sessionKey: string; cumulativeZat: string; sig: string },
  ctx: { scheme: string; network: string; payTo: string },
): boolean {
  try {
    const message = voucherMessage({
      scheme: ctx.scheme,
      network: ctx.network,
      payTo: ctx.payTo,
      sessionKey: p.sessionKey,
      cumulativeZat: p.cumulativeZat,
    });
    if (typeof p.sig !== "string" || !SIG_RE.test(p.sig)) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(p.sessionKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, publicKey, Buffer.from(p.sig, "hex"));
  } catch {
    return false;
  }
}

/** The 32-byte Ed25519 public key for `seed`, as 64 lowercase hex characters (the sessionKey). */
export function publicKeyFromSeed(seed: Uint8Array): string {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_ED25519_PREFIX.length).toString("hex");
}

export function generateSeed(): Uint8Array {
  return new Uint8Array(randomBytes(SEED_BYTES));
}
