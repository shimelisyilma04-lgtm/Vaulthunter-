import { describe, expect, it } from "vitest";
import { isBelowLiquidationThreshold, WAD } from "../src/domain/liquidation.js";
import { calculateNetProfit } from "../src/domain/profitability.js";

describe("liquidation screening", () => {
  it("flags health factors below one", () => {
    expect(isBelowLiquidationThreshold(WAD - 1n)).toBe(true);
  });

  it("does not flag health factors at or above one", () => {
    expect(isBelowLiquidationThreshold(WAD)).toBe(false);
    expect(isBelowLiquidationThreshold(WAD + 1n)).toBe(false);
  });
});

describe("profitability", () => {
  it("subtracts every cost and the safety margin", () => {
    const result = calculateNetProfit({
      grossProfit: 1000n,
      debtRepaymentCost: 100n,
      swapCost: 50n,
      gasCost: 100n,
      flashLoanFee: 20n,
      builderFee: 10n,
      safetyMargin: 70n
    });

    expect(result.netProfit).toBe(650n);
    expect(result.isCandidate).toBe(true);
  });

  it("rejects zero or negative net profit", () => {
    const result = calculateNetProfit({
      grossProfit: 100n,
      debtRepaymentCost: 100n,
      swapCost: 0n,
      gasCost: 0n,
      flashLoanFee: 0n,
      builderFee: 0n,
      safetyMargin: 0n
    });

    expect(result.netProfit).toBe(0n);
    expect(result.isCandidate).toBe(false);
  });
});
