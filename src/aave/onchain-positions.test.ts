import { describe, expect, it } from "vitest";
import { buildScreeningPairs } from "./onchain-positions.js";

const reserves: Parameters<typeof buildScreeningPairs>[0] = [
  {
    asset: "0x0000000000000000000000000000000000000001",
    symbol: "WETH",
    decimals: 18,
    suppliedBalance: "2000000000000000000",
    stableDebt: "0",
    variableDebt: "0",
    totalDebt: "0",
    isCollateral: true,
    liquidationThreshold: "8250",
    liquidationBonus: "10500",
    isActive: true,
    isFrozen: false
  },
  {
    asset: "0x0000000000000000000000000000000000000002",
    symbol: "USDC",
    decimals: 6,
    suppliedBalance: "0",
    stableDebt: "0",
    variableDebt: "1000000",
    totalDebt: "1000000",
    isCollateral: false,
    liquidationThreshold: "0",
    liquidationBonus: "10000",
    isActive: true,
    isFrozen: false
  }
];

describe("buildScreeningPairs", () => {
  it("returns collateral/debt pairs only below health factor 1", () => {
    expect(buildScreeningPairs(reserves, "999999999999999999")).toEqual([
      {
        collateralAsset: reserves[0]!.asset,
        collateralSymbol: "WETH",
        collateralBalance: "2000000000000000000",
        debtAsset: reserves[1]!.asset,
        debtSymbol: "USDC",
        debtBalance: "1000000",
        liquidationBonus: "10500"
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
});
