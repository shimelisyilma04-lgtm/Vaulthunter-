import { describe, expect, it } from "vitest";
import { estimateMorphoBlueLiquidation } from "../src/domain/morpho-profitability.js";

const WAD = 10n ** 18n;
const SCALE = 10n ** 36n;

function input(overrides: Record<string, string> = {}) {
  return {
    lltvWad: (86n * WAD / 100n).toString(),
    oraclePrice: SCALE.toString(),
    totalBorrowAssets: "1000000",
    totalBorrowShares: "1000000000000000000",
    positionBorrowShares: "870000000000000000",
    collateralAssets: "1000000",
    flashLoanFee: "100",
    swapAndSlippageCost: "200",
    gasCost: "300",
    builderFee: "0",
    safetyMargin: "100",
    ...overrides
  };
}

describe("Morpho Blue liquidation estimate", () => {
  it("calculates the protocol LIF and detects an unhealthy position", () => {
    const result = estimateMorphoBlueLiquidation(input());
    expect(result.eligibleByHealthCheck).toBe(true);
    expect(BigInt(result.liquidationIncentiveFactorWad)).toBeGreaterThan(WAD);
    expect(result.repaidAssets).toBe("870000");
    expect(result.collateralSufficient).toBe(true);
  });

  it("does not mark a healthy position as a liquidation candidate", () => {
    const result = estimateMorphoBlueLiquidation(input({
      positionBorrowShares: "800000",
      repaidShares: "800000"
    }));
    expect(result.eligibleByHealthCheck).toBe(false);
    expect(result.profitableBeforeForkSimulation).toBe(false);
  });

  it("rejects seizure greater than available collateral", () => {
    const result = estimateMorphoBlueLiquidation(input({
      collateralAssets: "100",
      flashLoanFee: "0",
      swapAndSlippageCost: "0",
      gasCost: "0",
      safetyMargin: "0"
    }));
    expect(result.collateralSufficient).toBe(false);
    expect(result.profitableBeforeForkSimulation).toBe(false);
  });

  it("supports a caller-selected partial share repayment", () => {
    const result = estimateMorphoBlueLiquidation(input({ repaidShares: "100000000000000000" }));
    expect(result.repaidShares).toBe("100000000000000000");
    expect(result.repaidAssets).toBe("100000");
  });

  it("rejects invalid LLTV, zero price and excessive repayment shares", () => {
    expect(() => estimateMorphoBlueLiquidation(input({ lltvWad: WAD.toString() }))).toThrow();
    expect(() => estimateMorphoBlueLiquidation(input({ oraclePrice: "0" }))).toThrow();
    expect(() => estimateMorphoBlueLiquidation(input({ repaidShares: "870000000000000001" }))).toThrow();
  });
});
