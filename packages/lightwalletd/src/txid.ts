import { TXID_RE } from "@z402-net/protocol";

export function txidToFilterHash(txid: string): Buffer {
  if (!TXID_RE.test(txid)) throw new TypeError("txid must be 64 lowercase hex characters");
  // TxFilter.hash is the txid in protocol byte order, the reverse of its display hex
  return Buffer.from(txid, "hex").reverse();
}
