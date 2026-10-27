import { ProtocolError } from "./errors.js";
import { REASON } from "./reasons.js";
import { parseZat } from "./validate.js";

/** The `extra` object of a prepaid-voucher `accepts` entry, as it travels on the wire (protocol.md §2). */
export interface PrepaidVoucherExtra {
  windowZat: string;
  creditRatioBps: number;
  creditCapZat: string;
  zeroConfMinExpiryBlocks: number;
}

export interface Terms {
  windowZat: bigint;
  creditRatioBps: number;
  creditCapZat: bigint;
  zeroConfMinExpiryBlocks: number;
}

export const DEMO_TERMS: Readonly<Terms> = Object.freeze({
  windowZat: 100000n,
  creditRatioBps: 2500,
  creditCapZat: 200000n,
  zeroConfMinExpiryBlocks: 20,
});

const MAX_BPS = 10000;

function invalid(message: string): ProtocolError {
  return new ProtocolError(REASON.invalidPaymentRequirements, message);
}

// parseZat reports invalid_payload; for terms the code must be invalid_payment_requirements.
function zatField(extra: Record<string, unknown>, name: string): bigint {
  try {
    return parseZat(extra[name] as string);
  } catch (e) {
    if (e instanceof ProtocolError) throw invalid(`${name}: ${e.message}`);
    throw e;
  }
}

function integerField(extra: Record<string, unknown>, name: string, max = Number.POSITIVE_INFINITY): number {
  const value = extra[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalid(`${name} is not an integer in range`);
  }
  return value;
}

/** Reads the wire `extra` object; unknown keys (`termsVersion` included) are ignored. */
export function parseTerms(extra: unknown): Terms {
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
    throw invalid("extra is not an object");
  }
  const fields = extra as Record<string, unknown>;

  const windowZat = zatField(fields, "windowZat");
  if (windowZat < 1n) throw invalid("windowZat must be at least 1");
  const creditCapZat = zatField(fields, "creditCapZat");
  const creditRatioBps = integerField(fields, "creditRatioBps", MAX_BPS);
  const zeroConfMinExpiryBlocks = integerField(fields, "zeroConfMinExpiryBlocks");

  return { windowZat, creditRatioBps, creditCapZat, zeroConfMinExpiryBlocks };
}

export function encodeTerms(t: Terms): PrepaidVoucherExtra {
  return {
    windowZat: t.windowZat.toString(),
    creditRatioBps: t.creditRatioBps,
    creditCapZat: t.creditCapZat.toString(),
    zeroConfMinExpiryBlocks: t.zeroConfMinExpiryBlocks,
  };
}
