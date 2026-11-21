import { describe, expect, it } from "vitest";
import { calculateNetProfit } from "../src/domain/net-profit.js";

describe("shared liquidation net-profit calculation", () => {
  it("deducts repayment, flash fee, gas, MEV, builder fee, safety and slippage once", () => {
    const result = calculateNetProfit({
      swapProceeds: "20000",
      repayment: "10000",
      flashLoanFee: "100",
      gasCost: "200",
      mevBudget: "300",
      builderFee: "50",
      safetyBuffer: "150",
      slippageBps: 100
    });
    expect(result.slippageAdjustedSwapProceeds).toBe("19800");
    expect(result.slippageHaircut).toBe("200");
    expect(result.netProfit).toBe("9000");
    expect(result.positive).toBe(true);
  });

  it("preserves negative net profit instead of clamping it to zero", () => {
    const result = calculateNetProfit({
      swapProceeds: "100",
      repayment: "1000",
      flashLoanFee: "1",
      gasCost: "1",
      mevBudget: "1",
      builderFee: "1",
      safetyBuffer: "1",
      slippageBps: 0
    });
    expect(result.netProfit).toBe("-905");
    expect(result.positive).toBe(false);
  });

  it("rejects invalid monetary inputs and invalid slippage", () => {
    expect(() => calculateNetProfit({
      swapProceeds: "-1", repayment: "1", flashLoanFee: "0", gasCost: "0",
      mevBudget: "0", builderFee: "0", safetyBuffer: "0", slippageBps: 0
    })).toThrow();
    expect(() => calculateNetProfit({
      swapProceeds: "1", repayment: "1", flashLoanFee: "0", gasCost: "0",
      mevBudget: "0", builderFee: "0", safetyBuffer: "0", slippageBps: 10_000
    })).toThrow();
  });
});
