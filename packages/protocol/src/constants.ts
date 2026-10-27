export const SCHEME = "prepaid-voucher";

export const NETWORK_TESTNET = "zcash:testnet";
export const NETWORK_REGTEST = "zcash:regtest";
export const NETWORK_MAINNET = "zcash:mainnet";

export const ASSET = "ZEC";
export const ZEC_DECIMALS = 8;

export const VOUCHER_DOMAIN = "z402-voucher-v1";

export const MAX_MONEY_ZAT = 2_100_000_000_000_000n;

export const FINAL_CONFIRMATIONS = 10;

/** Not-found streak that kills an unmined deposit (protocol.md §5.3): both bounds must hold. */
export const NOT_FOUND_DEAD_MS = 120_000;
export const NOT_FOUND_DEAD_BLOCKS = 2;
