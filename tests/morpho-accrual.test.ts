import { describe, expect, it } from "vitest";
import { accrueMorphoBorrowDebt, morphoTaylorCompounded, MORPHO_WAD } from "../src/morpho/accrual.js";

describe("Morpho Blue accrued borrow debt", () => {
  it("matches the first three Taylor terms used by Morpho", () => {
    const rate = 1_000_000_000n;
    const elapsed = 31_536_000n;
    const first = rate * elapsed;
    const second = first * first / (2n * MORPHO_WAD);
    const third = second * first / (3n * MORPHO_WAD);
    expect(morphoTaylorCompounded(rate, elapsed)).toBe(32_038_486_841_419_776n);
    expect(first + second + third).toBe(32_038_486_841_419_776n);
  });
  it("accrues market borrow assets and rounds borrower debt up", () => {
    const result = accrueMorphoBorrowDebt({
      totalBorrowAssets: 1_000_000n, totalBorrowShares: 3n, borrowShares: 1n,
      borrowRateWadPerSecond: 1_000_000_000n, elapsedSeconds: 31_536_000n
    });
    expect(result.accruedInterestAssets).toBe(32_038n);
    expect(result.accruedTotalBorrowAssets).toBe(1_000_000n + result.accruedInterestAssets);
    expect(result.borrowerDebtAssetsUp).toBe(1n);
  });
  it("uses Morpho virtual assets and virtual shares when converting debt", () => {
    const result = accrueMorphoBorrowDebt({ totalBorrowAssets: 1_000_000n, totalBorrowShares: 3n, borrowShares: 1n, borrowRateWadPerSecond: 0n, elapsedSeconds: 0n });
    expect(result.borrowerDebtAssetsUp).toBe(2n);
  });
  it("returns zero debt for zero borrower shares", () => {
    expect(accrueMorphoBorrowDebt({
      totalBorrowAssets: 100n, totalBorrowShares: 10n, borrowShares: 0n,
      borrowRateWadPerSecond: 1n, elapsedSeconds: 10n
    }).borrowerDebtAssetsUp).toBe(0n);
  });
  it("rejects impossible shares and negative rates", () => {
    expect(() => accrueMorphoBorrowDebt({
      totalBorrowAssets: 100n, totalBorrowShares: 0n, borrowShares: 1n,
      borrowRateWadPerSecond: 0n, elapsedSeconds: 1n
    })).toThrow();
    expect(() => morphoTaylorCompounded(-1n, 1n)).toThrow();
  });
  it("does not accrue when no time has elapsed", () => {
    expect(morphoTaylorCompounded(10n ** 12n, 0n)).toBe(0n);
  });
});
