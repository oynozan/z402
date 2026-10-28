import { describe, expect, test } from "vitest";
import {
  DASH,
  countOf,
  formatBps,
  formatCount,
  formatCountCompact,
  formatPriceRange,
  formatZat,
  groupDigits,
  shortAddress,
  zatDigits,
} from "../src/lib/format";

describe("zatDigits", () => {
  test("reads whole zatoshi from a string or a number", () => {
    expect(zatDigits("500")).toBe("500");
    expect(zatDigits(" 1000 ")).toBe("1000");
    expect(zatDigits(500)).toBe("500");
    expect(zatDigits("0")).toBe("0");
    expect(zatDigits("000500")).toBe("500");
  });

  test("refuses anything that is not a whole, non-negative amount", () => {
    for (const bad of ["", "5.5", "-1", "1e3", "abc", "500 zat", 5.5, -1, Number.NaN, null, undefined, {}]) {
      expect(zatDigits(bad)).toBeNull();
    }
  });

  test("keeps amounts past the safe integer range exact", () => {
    expect(zatDigits("2100000000000000")).toBe("2100000000000000");
  });
});

describe("formatZat", () => {
  test("prints the amount and the unit with grouped digits", () => {
    expect(formatZat("500")).toBe("500 zat");
    expect(formatZat(100000)).toBe("100,000 zat");
    expect(formatZat("2100000000000000")).toBe("2,100,000,000,000,000 zat");
  });

  test("prints a dash for a value it cannot read", () => {
    expect(formatZat(null)).toBe(DASH);
    expect(formatZat("free")).toBe(DASH);
  });
});

describe("formatPriceRange", () => {
  test("prints one price when every route charges the same", () => {
    expect(formatPriceRange(["500", 500, "0500"])).toBe("500 zat");
  });

  test("prints the lowest and highest price when routes differ", () => {
    expect(formatPriceRange(["1000", "500", null, "2500"])).toBe("500–2,500 zat");
  });

  test("prints a dash when no route has a price", () => {
    expect(formatPriceRange([])).toBe(DASH);
    expect(formatPriceRange([null, "n/a"])).toBe(DASH);
  });
});

describe("counts", () => {
  test("groupDigits splits in threes from the right", () => {
    expect(groupDigits("1")).toBe("1");
    expect(groupDigits("1234")).toBe("1,234");
    expect(groupDigits("1234567")).toBe("1,234,567");
  });

  test("formatCount prints a dash for no count", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(null)).toBe(DASH);
    expect(formatCount(-3)).toBe(DASH);
  });

  test("formatCountCompact groups below a million and cuts to tenths above, never rounding up", () => {
    expect(formatCountCompact(0)).toBe("0");
    expect(formatCountCompact(999_999)).toBe("999,999");
    expect(formatCountCompact(1_000_000)).toBe("1M");
    expect(formatCountCompact(1_234_567)).toBe("1.2M");
    expect(formatCountCompact(999_999_999)).toBe("999.9M");
    expect(formatCountCompact(12_050_000_000)).toBe("12B");
    expect(formatCountCompact(1_234_567_890_123)).toBe("1,234.5B");
    expect(formatCountCompact(null)).toBe(DASH);
    expect(formatCountCompact(1.5)).toBe(DASH);
  });

  test("countOf accepts a number or a numeric string", () => {
    expect(countOf(7)).toBe(7);
    expect(countOf("42")).toBe(42);
    expect(countOf("4.2")).toBeNull();
    expect(countOf(-1)).toBeNull();
    expect(countOf(undefined)).toBeNull();
  });
});

describe("terms", () => {
  test("formatBps prints basis points as a percentage", () => {
    expect(formatBps(2500)).toBe("25%");
    expect(formatBps(1250)).toBe("12.5%");
    expect(formatBps(1)).toBe("0.01%");
    expect(formatBps(0)).toBe("0%");
    expect(formatBps(10_000)).toBe("100%");
    expect(formatBps(null)).toBe(DASH);
    expect(formatBps(2.5)).toBe(DASH);
  });

  test("shortAddress keeps the start and the end of a long address", () => {
    const address = `uregtest1${"a".repeat(120)}xyz789`;
    expect(shortAddress(address)).toBe("uregtest1aaaa…xyz789");
    expect(shortAddress("t1short")).toBe("t1short");
  });
});
