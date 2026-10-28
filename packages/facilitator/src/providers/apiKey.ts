import { createHash, randomBytes } from "node:crypto";

/** The shape of an issued key, z402_ and 43 base64url characters, which is also a valid RFC 6750 b64token */
export const API_KEY_RE = /^z402_[A-Za-z0-9_-]{43}$/;

/** A fresh key of 256 random bits, shown to its provider once and kept by the facilitator only as a digest */
export function newApiKey(): string {
  return "z402_" + randomBytes(32).toString("base64url");
}

/** What a key is stored and looked up by, the sha256 of its UTF-8 bytes in lowercase hex */
export function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
