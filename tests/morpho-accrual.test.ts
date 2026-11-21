import { describe, expect, it } from "vitest";
import { morphoAccrueTotalBorrowAssets, morphoTaylorCompounded, morphoToAssetsDown, morphoToAssetsUp } from "../src/morpho/blue.js";

const WAD = 10n ** 18n;

describe("Morpho Blue Taylor-compounded interest", () => {
  it("returns zero for a zero rate or zero elapsed time", () => {
    expect(morphoTaylorCompounded(0n, 100n)).toBe(0n);
    expect(morphoTaylorCompounded(WAD / 100_000n, 0n)).toBe(0n);
  });

  it("matches Morpho core three-term Taylor truncation and rounding", () => {
    const rate = WAD / 100_000n;
    const elapsed = 3_600n;
    const x = rate * elapsed;
    const secondTerm = x * x / (2n * WAD);
    const thirdTerm = secondTerm * x / (3n * WAD);
    const expected = x + secondTerm + thirdTerm;
    expect(morphoTaylorCompounded(rate, elapsed)).toBe(expected);
    expect(morphoTaylorCompounded(rate, elapsed)).toBeGreaterThan(x);
  });

  it("accrues total borrow assets using the core three-term rate at the pinned elapsed time", () => {
    const total = 1_000_000n;
    const rate = WAD / 100_000n;
    const elapsed = 3_600n;
    const compounded = morphoTaylorCompounded(rate, elapsed);
    expect(morphoAccrueTotalBorrowAssets(total, rate, elapsed))
      .toBe(total + total * compounded / WAD);
    expect(morphoAccrueTotalBorrowAssets(total, 0n, elapsed)).toBe(total);
    expect(morphoAccrueTotalBorrowAssets(total, rate, 0n)).toBe(total);
    expect(() => morphoAccrueTotalBorrowAssets(total, -1n, elapsed)).toThrow();
    expect(() => morphoAccrueTotalBorrowAssets((1n << 128n) - 1n, WAD, 1n)).toThrow(/uint128/);
  });

  it("uses Morpho core virtual assets and virtual shares for share conversion", () => {
    expect(morphoToAssetsUp(1n, 0n, 0n)).toBe(1n);
    expect(morphoToAssetsDown(1n, 0n, 0n)).toBe(0n);
    expect(morphoToAssetsUp(1_000_000n, 100n, 1_000_000n)).toBe(51n);
    expect(morphoToAssetsDown(1_000_000n, 100n, 1_000_000n)).toBe(50n);
  });

  it("is monotonic with elapsed time for a non-negative rate", () => {
    const rate = WAD / 1_000_000n;
    expect(morphoTaylorCompounded(rate, 3_600n))
      .toBeLessThan(morphoTaylorCompounded(rate, 7_200n));
  });
});
