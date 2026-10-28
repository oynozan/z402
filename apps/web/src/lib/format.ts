export const DASH = "—";

/** A whole number of zatoshi as canonical digits, or null when the value is not one */
export function zatDigits(value: unknown): string | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!/^\d+$/.test(text)) return null;
  return text.replace(/^0+(?=\d)/, "");
}

/** Groups digits in threes with commas, the same on the server and in every browser */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatZat(value: unknown): string {
  const digits = zatDigits(value);
  return digits === null ? DASH : `${groupDigits(digits)} zat`;
}

/** One price, or the lowest and highest when the routes of a service differ */
export function formatPriceRange(values: readonly unknown[]): string {
  const prices = values.map(zatDigits).filter((d): d is string => d !== null);
  if (prices.length === 0) return DASH;
  const sorted = [...prices].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  return low === high ? formatZat(low) : `${groupDigits(low)}–${groupDigits(high)} zat`;
}

export function formatCount(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return DASH;
  return groupDigits(String(value));
}

/** A count for a narrow cell, grouped below a million and cut to a tenth of a million or billion above */
export function formatCountCompact(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return DASH;
  if (value < 1_000_000) return groupDigits(String(value));
  const [tenth, suffix] = value < 1_000_000_000 ? [100_000, "M"] : [100_000_000, "B"];
  const tenths = Math.floor(value / tenth);
  return `${groupDigits(String(Math.floor(tenths / 10)))}${tenths % 10 === 0 ? "" : `.${tenths % 10}`}${suffix}`;
}

/** A count from JSON that may arrive as a number or a numeric string */
export function countOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** Basis points as a percentage, 2500 as 25% and 1250 as 12.5% */
export function formatBps(value: number | null): string {
  if (value === null || !Number.isInteger(value) || value < 0) return DASH;
  return `${(value / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function formatMs(value: number | null): string {
  return value === null || !Number.isFinite(value) || value < 0 ? DASH : `${groupDigits(String(Math.round(value)))} ms`;
}

/** The start and end of a long address, which is all a reader compares */
export function shortAddress(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 13)}…${value.slice(-6)}`;
}
