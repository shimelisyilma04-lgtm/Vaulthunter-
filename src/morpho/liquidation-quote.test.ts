import { describe, expect, it } from "vitest";
import { MORPHO_WAD } from "./accrual.js";
import { quoteMorphoLiquidation } from "./liquidation-quote.js";

const PRICE = 10n ** 36n;
const WAD = MORPHO_WAD;

function quote(overrides: Partial<Parameters<typeof quoteMorphoLiquidation>[0]> = {}) {
  return quoteMorphoLiquidation({
    totalBorrowAssets: 1_000_000_000n,
    totalBorrowShares: 1_000_000_000n,
    borrowerBorrowShares: 900_000_000n,
    borrowerCollateralAssets: 1_000_000_000n,
    oraclePrice: PRICE,
    lltvWad: 86n * 10n ** 16n,
    repaidShares: 900_000_000n,
    availableLoanLiquidity: 2_000_000_000n,
    ...overrides
  });
}

describe("Morpho Blue liquidation quote", () => {
  it("uses Morpho share-based rounding for a normal partial liquidation", () => {
    const result = quote({ repaidShares: 100_000_000n });
    expect(result.liquidationMode).toBe("repaid-shares");
    expect(result.repaidShares).toBe(100_000_000n);
    expect(result.seizedAssets).toBeLessThanOrEqual(1_000_000_000n);
    expect(result.collateralSufficient).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("caps seizure at the borrower's collateral and derives repayment shares using Morpho's seizedAssets branch", () => {
    const result = quote({
      borrowerBorrowShares: 900_000_000_000n,
      totalBorrowAssets: 1_000_000_000_000n,
      totalBorrowShares: 1_000_000_000_000n,
      borrowerCollateralAssets: 1n,
      repaidShares: 900_000_000_000n
    });
    expect(result.liquidationMode).toBe("seized-collateral");
    expect(result.collateralLimited).toBe(true);
    expect(result.seizedAssets).toBe(1n);
    expect(result.remainingCollateralAssets).toBe(0n);
    expect(result.collateralSufficient).toBe(true);
    expect(result.repaidShares).toBeLessThanOrEqual(900_000_000_000n);
    expect(result.valid).toBe(true);
  });

  it("handles tiny positions and virtual-share rounding without negative balances", () => {
    const result = quote({
      totalBorrowAssets: 100n,
      totalBorrowShares: 100n,
      borrowerBorrowShares: 1n,
      borrowerCollateralAssets: 10n,
      repaidShares: 1n,
      availableLoanLiquidity: 10n
    });
    expect(result.repaidAssets).toBeGreaterThanOrEqual(0n);
    expect(result.seizedAssets).toBeLessThanOrEqual(10n);
    expect(result.remainingCollateralAssets).toBeGreaterThanOrEqual(0n);
    expect(result.remainingBorrowShares).toBeGreaterThanOrEqual(0n);
  });

  it("handles very large integer positions without floating-point precision loss", () => {
    const huge = 10n ** 30n;
    const result = quote({
      totalBorrowAssets: huge,
      totalBorrowShares: huge,
      borrowerBorrowShares: huge / 2n,
      borrowerCollateralAssets: huge,
      repaidShares: huge / 4n,
      availableLoanLiquidity: huge
    });
    expect(result.repaidShares).toBe(huge / 4n);
    expect(result.valid).toBe(true);
    expect(result.seizedAssets).toBeLessThanOrEqual(huge);
  });

  it("treats health factor exactly one as healthy and just below one as liquidatable", () => {
    const collateral = 100_000_000n;
    const totalAssets = 100_000_000n;
    const totalShares = 100_000_000n;
    const llTV = 86n * 10n ** 16n;
    const maxBorrowAssets = collateral * llTV / WAD;
    const thresholdShares = maxBorrowAssets * (totalShares + 1_000_000n) / (totalAssets + 1n);
    const atThreshold = quote({
      totalBorrowAssets: totalAssets,
      totalBorrowShares: totalShares,
      borrowerBorrowShares: thresholdShares,
      borrowerCollateralAssets: collateral,
      lltvWad: llTV,
      repaidShares: 1n
    });
    const belowThreshold = quote({
      totalBorrowAssets: totalAssets,
      totalBorrowShares: totalShares,
      borrowerBorrowShares: thresholdShares + 1n,
      borrowerCollateralAssets: collateral,
      lltvWad: llTV,
      repaidShares: 1n
    });
    expect(atThreshold.liquidatable).toBe(false);
    expect(belowThreshold.liquidatable).toBe(true);
    expect(llTV).toBe(86n * 10n ** 16n);
    expect(WAD).toBe(10n ** 18n);
  });

  it("rejects impossible zero-collateral and over-repayment inputs", () => {
    expect(() => quote({ borrowerCollateralAssets: 0n })).toThrow(/no collateral/i);
    expect(() => quote({ repaidShares: 900_000_001n })).toThrow(/exceed borrower/i);
  });
});
