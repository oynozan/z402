export const SCHEME = "prepaid-voucher";

export const NETWORK_TESTNET = "zcash:testnet";
export const NETWORK_REGTEST = "zcash:regtest";
export const NETWORK_MAINNET = "zcash:mainnet";

export type ZcashNetwork = typeof NETWORK_REGTEST | typeof NETWORK_TESTNET | typeof NETWORK_MAINNET;

export const ZCASH_NETWORKS: readonly ZcashNetwork[] = Object.freeze([
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  NETWORK_MAINNET,
]);

/** Exact string membership in `ZCASH_NETWORKS`; never consults the prototype chain. */
export function isZcashNetwork(s: unknown): s is ZcashNetwork {
  return typeof s === "string" && (ZCASH_NETWORKS as readonly string[]).includes(s);
}

export const ASSET = "ZEC";
export const ZEC_DECIMALS = 8;

export const VOUCHER_DOMAIN = "z402-voucher-v1";

export const MAX_MONEY_ZAT = 2_100_000_000_000_000n;

export const FINAL_CONFIRMATIONS = 10;

/** Not-found streak that kills an unmined deposit (protocol.md §5.3): both bounds must hold. */
export const NOT_FOUND_DEAD_MS = 120_000;
export const NOT_FOUND_DEAD_BLOCKS = 2;
