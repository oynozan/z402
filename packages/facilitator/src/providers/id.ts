import { createHash } from "node:crypto";

/** The first 16 hex of sha256 over a domain tag, the network and payTo, so a key rotation keeps the provider's id */
export function providerId(network: string, payTo: string): string {
  return createHash("sha256").update(`z402-provider-v1\n${network}\n${payTo}`).digest("hex").slice(0, 16);
}
