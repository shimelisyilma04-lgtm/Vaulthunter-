import { describe, expect, it } from "vitest";
import { buildScreeningPairs } from "./onchain-positions.js";

const reserves: Parameters<typeof buildScreeningPairs>[0] = [
  {
    asset: "0x0000000000000000000000000000000000000001",
    symbol: "WETH",
    eModeCategory: 0,
    decimals: 18,
    suppliedBalance: "2000000000000000000",
    stableDebt: "0",
    variableDebt: "0",
    totalDebt: "0",
    isCollateral: true,
    liquidationThreshold: "8250",
    liquidationBonus: "10500",
    liquidationProtocolFee: "1000",
    isActive: true,
    isFrozen: false,
    oraclePriceBase: "200000000000",
    suppliedValueBase: "40000000000",
    debtValueBase: "0"
  },
  {
    asset: "0x0000000000000000000000000000000000000002",
    symbol: "USDC",
    eModeCategory: 0,
    decimals: 6,
    suppliedBalance: "0",
    stableDebt: "0",
    variableDebt: "1000000",
    totalDebt: "1000000",
    isCollateral: false,
    liquidationThreshold: "0",
    liquidationBonus: "10000",
    liquidationProtocolFee: "0",
    isActive: true,
    isFrozen: false,
    oraclePriceBase: "100000000",
    suppliedValueBase: "0",
    debtValueBase: "100000000"
  }
];

describe("buildScreeningPairs", () => {
  it("returns collateral/debt pairs only below health factor 1", () => {
    expect(buildScreeningPairs(reserves, "999999999999999999")).toEqual([
      {
        collateralAsset: reserves[0]!.asset,
        collateralSymbol: "WETH",
        collateralBalance: "2000000000000000000",
        collateralDecimals: 18,
        collateralValueBase: "40000000000",
        debtAsset: reserves[1]!.asset,
        debtSymbol: "USDC",
        debtBalance: "1000000",
        debtDecimals: 6,
        debtValueBase: "100000000",
        liquidationBonus: "10500",
        liquidationProtocolFee: "1000",
        eModeCompatible: false,
        effectiveLiquidationBonus: "10500"
      }
    ]);
    expect(buildScreeningPairs(reserves, "1000000000000000000")).toEqual([]);
  });

  it("excludes inactive reserves and reserves not enabled as collateral", () => {
    const rows = reserves.map((row) => ({ ...row }));
    rows[0]!.isActive = false;
    rows[1]!.isCollateral = true;
    expect(buildScreeningPairs(rows, "900000000000000000")).toEqual([]);
  });

  it("keeps same-asset collateral/debt pairs for protocol validation", () => {
    const sameAsset = [
      { ...reserves[0]!, totalDebt: "100", variableDebt: "100" }
    ];
    expect(buildScreeningPairs(sameAsset, "900000000000000000")).toHaveLength(1);
  });
  it("uses the user's eMode category bonus only when both reserves match the category", () => {
    const categoryRows = reserves.map((row) => ({ ...row, eModeCategory: 1 }));
    const pairs = buildScreeningPairs(categoryRows, "900000000000000000", 1, "10750");
    expect(pairs[0]?.eModeCompatible).toBe(true);
    expect(pairs[0]?.effectiveLiquidationBonus).toBe("10750");

    categoryRows[0]!.eModeCategory = 0;
    const mismatchedCollateral = buildScreeningPairs(categoryRows, "900000000000000000", 1, "10750");
    expect(mismatchedCollateral[0]?.eModeCompatible).toBe(false);
    expect(mismatchedCollateral[0]?.effectiveLiquidationBonus).toBe("10500");
  });

});
