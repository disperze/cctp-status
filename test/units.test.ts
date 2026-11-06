import { describe, expect, it } from "vitest";
import { ceilDiv, formatUsdc, parseDecimalRatio, parseRaw, parseUsdc, toUsdcString } from "../src/units";

describe("formatUsdc", () => {
  it("formats the sample burn limit (acceptance 1)", () => {
    expect(formatUsdc(500000000000n)).toBe("500,000");
    expect(formatUsdc(500000000000n, { full: true })).toBe("500,000.000000");
  });

  it("formats the sample minter allowance (acceptance 2)", () => {
    expect(formatUsdc(75000000000000n)).toBe("75,000,000");
  });

  it("keeps sub-unit precision exactly", () => {
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(1234500000n)).toBe("1,234.5");
    expect(formatUsdc(73186100066559n)).toBe("73,186,100.066559");
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(0n, { full: true })).toBe("0.000000");
  });

  it("handles negatives (deltas) and values beyond Number.MAX_SAFE_INTEGER", () => {
    expect(formatUsdc(-100000000000n)).toBe("-100,000");
    expect(formatUsdc(123456789012345678901234567n)).toBe("123,456,789,012,345,678,901.234567");
  });

  it("toUsdcString has no grouping", () => {
    expect(toUsdcString(88388165260063n)).toBe("88388165.260063");
    expect(toUsdcString(500000000000n)).toBe("500000");
  });
});

describe("parseUsdc", () => {
  it("parses whole, grouped and fractional amounts", () => {
    expect(parseUsdc("2000000")).toBe(2000000000000n);
    expect(parseUsdc("2,000,000")).toBe(2000000000000n);
    expect(parseUsdc("1500.25")).toBe(1500250000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc(".5")).toBe(500000n);
  });

  it("rejects junk, negatives and too many decimals", () => {
    for (const bad of ["", "abc", "-1", "1.0000001", "1e6", "1.2.3", "."]) {
      expect(() => parseUsdc(bad), bad).toThrow();
    }
  });

  it("round-trips with formatUsdc", () => {
    for (const v of [1n, 999999n, 1000000n, 500000000000n, 73186100066559n]) {
      expect(parseUsdc(formatUsdc(v))).toBe(v);
    }
  });
});

describe("parseRaw / parseDecimalRatio / ceilDiv", () => {
  it("parseRaw accepts only integer strings", () => {
    expect(parseRaw("500000000000")).toBe(500000000000n);
    expect(() => parseRaw("5e11")).toThrow();
    expect(() => parseRaw(5)).toThrow();
    expect(() => parseRaw("-1")).toThrow();
  });

  it("parseDecimalRatio is exact", () => {
    expect(parseDecimalRatio("0.998")).toEqual({ num: 998n, den: 1000n });
    expect(parseDecimalRatio("1")).toEqual({ num: 1n, den: 1n });
    expect(parseDecimalRatio("0.95")).toEqual({ num: 95n, den: 100n });
    expect(() => parseDecimalRatio("abc")).toThrow();
  });

  it("ceilDiv", () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(1n, 5n)).toBe(1n);
    expect(() => ceilDiv(1n, 0n)).toThrow();
  });
});
