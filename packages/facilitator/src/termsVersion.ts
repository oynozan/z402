import { createHash } from "node:crypto";
import { encodeTerms, type Terms } from "@z402/protocol";

/** The opaque id the API checks at startup to catch drift between its terms and the facilitator's */
export function termsVersion(payTo: string, priceZat: bigint, terms: Terms): string {
  const canonical = JSON.stringify([payTo, String(priceZat), encodeTerms(terms)]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
