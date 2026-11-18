import { describe, expect, it } from "vitest";
import { isBelowLiquidationThreshold, WAD } from "../src/domain/liquidation.js";
import { calculateNetProfit, estimateAaveV3Liquidation } from "../src/domain/profitability.js";

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


describe("Aave V3 liquidation screening", () => {
  const base = {
    healthFactor: 0.94,
    totalDebtUsd: 10_000,
    debtReserveUsd: 8_000,
    collateralReserveUsd: 12_000,
    collateralAvailableUsd: 12_000,
    liquidationBonusBps: 500,
    gasCostUsd: 20,
    flashLoanFeeBps: 5,
    swapFeeBps: 30,
    slippageBps: 20,
    protocolFeeBps: 1_000,
    safetyBufferBps: 500
  };

  it("uses the full close factor at or below HF 0.95", () => {
    expect(estimateAaveV3Liquidation(base).closeFactorBps).toBe(10_000);
    expect(estimateAaveV3Liquidation({ ...base, healthFactor: 0.950001 }).closeFactorBps).toBe(5_000);
  });

  it("uses the full close factor when either selected position is below $2,000", () => {
    expect(estimateAaveV3Liquidation({ ...base, healthFactor: 0.99, debtReserveUsd: 1_999 }).closeFactorBps).toBe(10_000);
    expect(estimateAaveV3Liquidation({ ...base, healthFactor: 0.99, collateralReserveUsd: 1_999 }).closeFactorBps).toBe(10_000);
  });

  it("rejects partial liquidations that leave less than $1,000 of debt or collateral", () => {
    const result = estimateAaveV3Liquidation({
      ...base,
      healthFactor: 0.99,
      debtReserveUsd: 2_500,
      collateralReserveUsd: 3_000,
      collateralAvailableUsd: 3_000,
      totalDebtUsd: 5_000,
      liquidationBonusBps: 500
    });
    expect(result.closeFactorBps).toBe(5_000);
    expect(result.dustRuleSatisfied).toBe(false);
    expect(result.profitableBeforeExecutionChecks).toBe(false);
  });

  it("caps repayment by available collateral after the bonus", () => {
    const result = estimateAaveV3Liquidation({
      ...base,
      debtReserveUsd: 8_000,
      collateralReserveUsd: 12_000,
      collateralAvailableUsd: 1_050,
      liquidationBonusBps: 1_000
    });
    expect(result.maxRepayUsd).toBeLessThanOrEqual(1_050 / 1.1);
    expect(result.collateralSeizedUsd).toBeLessThanOrEqual(1_050 + 1e-8);
  });
});
