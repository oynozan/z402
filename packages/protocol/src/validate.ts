import {
  isZcashNetwork,
  MAX_MONEY_ZAT,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  type ZcashNetwork,
} from "./constants.js";
import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";

export const SESSION_KEY_RE = /^[0-9a-f]{64}$/;
export const ZAT_RE = /^(0|[1-9][0-9]{0,15})$/;
export const SIG_RE = /^[0-9a-f]{128}$/;
export const TXID_RE = /^[0-9a-f]{64}$/;
export const DEPOSIT_INDEX_RE = /^(0|[1-9][0-9]{0,8})$/;

// Per network: the R0 unified-address HRP and the ZIP 316 Revision 2 shielded-only HRP.
// The Revision 2 transparent-including HRP (tutest, turegtest, tu) is deliberately absent.
// Source: zcash_address 0.14.0 src/constants.rs. The body is lowercase bech32 data.
export const PAY_TO_RES: Readonly<Record<ZcashNetwork, RegExp>> = {
  [NETWORK_TESTNET]: /^(utest|zutest)1[02-9ac-hj-np-z]+$/,
  [NETWORK_REGTEST]: /^(uregtest|zuregtest)1[02-9ac-hj-np-z]+$/,
  [NETWORK_MAINNET]: /^(u|zu)1[02-9ac-hj-np-z]+$/,
};

export function parseZat(s: string): bigint {
  if (typeof s !== "string" || !ZAT_RE.test(s)) {
    throw new ProtocolError(REASON.invalidPayload, "amount is not a canonical zatoshi decimal");
  }
  const zat = BigInt(s);
  if (zat > MAX_MONEY_ZAT) {
    throw new ProtocolError(REASON.invalidPayload, "amount exceeds MAX_MONEY_ZAT");
  }
  return zat;
}

export function isValidPayTo(ua: string, network: string): boolean {
  return isZcashNetwork(network) && PAY_TO_RES[network].test(ua);
}
