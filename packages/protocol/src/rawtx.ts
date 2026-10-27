import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";

const EXPIRY_HEIGHT_OFFSET = 16;
const MIN_LENGTH = EXPIRY_HEIGHT_OFFSET + 4;
const OVERWINTERED_BIT = 31;
const VERSION_MASK = 0x7fffffff;

function invalid(message: string): ProtocolError {
  return new ProtocolError(REASON.invalidPayload, message);
}

/** Reads the little-endian u32 at bytes 16..20 of a v5 or v6 transaction (protocol.md section 5.3). */
export function expiryHeightFromRawTx(raw: Uint8Array): number {
  if (raw.length < MIN_LENGTH) throw invalid("raw transaction is too short");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const header = view.getUint32(0, true);
  const version = header & VERSION_MASK;
  if (header >>> OVERWINTERED_BIT !== 1 || (version !== 5 && version !== 6)) {
    throw invalid("raw transaction is not v5 or v6");
  }
  return view.getUint32(EXPIRY_HEIGHT_OFFSET, true);
}
