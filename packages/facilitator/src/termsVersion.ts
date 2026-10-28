import { createHash } from "node:crypto";
import { encodeTerms, type Terms } from "@z402/protocol";

/** The opaque id of the rail's terms, which the API copies into requirements and checks only for its format */
export function termsVersion(terms: Terms): string {
  const canonical = JSON.stringify(["z402-terms-v2", encodeTerms(terms)]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
