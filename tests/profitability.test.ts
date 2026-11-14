import { describe, expect, it } from "vitest";
import { estimateAaveV3Liquidation } from "../src/domain/profitability.js";

describe("estimateAaveV3Liquidation", () => {
  const base = {
    healthFactor: 0.99,
    totalDebtUsd: 10_000,
    debtReserveUsd: 5_000,
    collateralReserveUsd: 8_000,
    collateralAvailableUsd: 8_000,
    liquidationBonusBps: 500,
    gasCostUsd: 10,
    flashLoanFeeBps: 10,
    swapFeeBps: 30,
    slippageBps: 50,
    protocolFeeBps: 1_000,
    safetyBufferBps: 500
  };

  it("uses the 50% close factor for a normal-sized position above 0.95 HF", () => {
    const result = estimateAaveV3Liquidation(base);
    expect(result.eligibleByHealthFactor).toBe(true);
    expect(result.closeFactorBps).toBe(5_000);
    expect(result.maxRepayUsd).toBe(2_500);
    expect(result.estimatedNetProfitUsd).toBeGreaterThan(0);
  });

  it("allows the 100% close factor at or below 0.95 HF", () => {
    const result = estimateAaveV3Liquidation({ ...base, healthFactor: 0.95 });
    expect(result.closeFactorBps).toBe(10_000);
  });

  it("allows the 100% close factor when either selected reserve position is below $2,000", () => {
    const result = estimateAaveV3Liquidation({ ...base, debtReserveUsd: 1_999 });
    expect(result.closeFactorBps).toBe(10_000);
  });

  it("does not return an opportunity for a healthy or debt-free account", () => {
    expect(estimateAaveV3Liquidation({ ...base, healthFactor: 1.01 }).eligibleByHealthFactor).toBe(false);
    expect(estimateAaveV3Liquidation({ ...base, totalDebtUsd: 0 }).maxRepayUsd).toBe(0);
  });

  it("applies close factor to selected reserve debt, not aggregate account debt", () => {
    const result = estimateAaveV3Liquidation({ ...base, totalDebtUsd: 50_000, debtReserveUsd: 4_000 });
    expect(result.maxRepayUsd).toBe(2_000);
  });

  it("caps repayment by available collateral after the liquidation bonus", () => {
    const result = estimateAaveV3Liquidation({
      ...base,
      healthFactor: 0.94,
      totalDebtUsd: 10_000,
      debtReserveUsd: 5_000,
      collateralReserveUsd: 5_000,
      collateralAvailableUsd: 2_000
    });
    expect(result.maxRepayUsd).toBeLessThanOrEqual(2_000 / 1.05);
  });

  it("rejects invalid basis-point inputs", () => {
    expect(() => estimateAaveV3Liquidation({ ...base, liquidationBonusBps: 10_000 })).toThrow();
  });
});
