import { describe, expect, it } from "vitest";
import { quoteMorphoLiquidation } from "../src/morpho/liquidation-quote.js";

const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 36n;

describe("Morpho Blue liquidation quote", () => {
  const base = {
    totalBorrowAssets: 1_000_000_000n,
    totalBorrowShares: 1_000_000_000n,
    borrowerBorrowShares: 200_000_000n,
    borrowerCollateralAssets: 100_000_000n,
    oraclePrice: 2n * PRICE_SCALE,
    lltvWad: 860_000_000_000_000_000n,
    repaidShares: 50_000_000n,
    availableLoanLiquidity: 1_000_000_000n
  };

  it("flags a healthy position as not liquidatable", () => {
    const result = quoteMorphoLiquidation({ ...base, borrowerCollateralAssets: 200_000_000n });
    expect(result.liquidatable).toBe(false);
  });

  it("quotes a liquidatable position using protocol incentive and virtual-share rounding", () => {
    const result = quoteMorphoLiquidation(base);
    expect(result.liquidatable).toBe(true);
    expect(result.repaidAssets).toBeGreaterThan(0n);
    expect(result.seizedAssets).toBeGreaterThan(0n);
    expect(result.liquidationIncentiveFactorWad).toBeGreaterThan(WAD);
    expect(result.collateralSufficient).toBe(true);
    expect(result.liquiditySufficient).toBe(true);
  });

  it("does not mark a quote executable when collateral is insufficient", () => {
    const result = quoteMorphoLiquidation({ ...base, borrowerCollateralAssets: 1n });
    expect(result.collateralSufficient).toBe(false);
  });

  it("does not mark a quote executable when loan liquidity is insufficient", () => {
    const result = quoteMorphoLiquidation({ ...base, availableLoanLiquidity: 1n });
    expect(result.liquiditySufficient).toBe(false);
  });

  it("rejects repaying more shares than the borrower owns", () => {
    expect(() => quoteMorphoLiquidation({ ...base, repaidShares: base.borrowerBorrowShares + 1n })).toThrow();
  });

  it("rejects a zero oracle price", () => {
    expect(() => quoteMorphoLiquidation({ ...base, oraclePrice: 0n })).toThrow();
  });
});
