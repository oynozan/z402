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
