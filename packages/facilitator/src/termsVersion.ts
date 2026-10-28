import { createHash } from "node:crypto";
import { encodeTerms, type Terms } from "@z402/protocol";

/** The opaque id of payTo, price and terms, which the API copies into requirements and checks only for its format */
export function termsVersion(payTo: string, priceZat: bigint, terms: Terms): string {
  const canonical = JSON.stringify([payTo, String(priceZat), encodeTerms(terms)]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
