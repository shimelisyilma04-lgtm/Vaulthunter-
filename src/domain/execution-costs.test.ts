import { describe, expect, it } from "vitest";
import { estimateExecutionCosts } from "./execution-costs.js";

describe("estimateExecutionCosts", () => {
  it("converts max gas exposure and rounds all cost buckets up in USD cents", () => {
    const result = estimateExecutionCosts({
      grossProfitUsdCents: "10000",
      gasLimit: "100000",
      maxFeePerGasWei: "30000000000",
      nativeAssetPriceUsdWad: "3000000000000000000000",
      flashLoanPrincipalUsdCents: "100000",
      flashLoanFeeBps: 5,
      swapNotionalUsdCents: "100000",
      swapFeeBps: 30,
      slippageBps: 20,
      builderFeeUsdCents: "25",
      safetyBufferBps: 500
    });
    expect(result.gasCostUsdCents).toBe("900");
    expect(result.flashLoanFeeUsdCents).toBe("50");
    expect(result.swapAndSlippageCostUsdCents).toBe("500");
    expect(result.builderFeeUsdCents).toBe("25");
    expect(result.safetyBufferUsdCents).toBe("500");
    expect(result.totalEstimatedCostsUsdCents).toBe("1975");
    expect(result.estimatedNetProfitUsdCents).toBe("8025");
    expect(result.profitableBeforeForkSimulation).toBe(true);
  });

  it("rejects fractional, negative, malformed and excessive basis-point inputs", () => {
    const base = {
      grossProfitUsdCents: "1000", gasLimit: "1", maxFeePerGasWei: "1",
      nativeAssetPriceUsdWad: "1", flashLoanPrincipalUsdCents: "1",
      flashLoanFeeBps: 0, swapNotionalUsdCents: "1", swapFeeBps: 0,
      slippageBps: 0, builderFeeUsdCents: "0", safetyBufferBps: 0
    };
    expect(() => estimateExecutionCosts({ ...base, gasLimit: "-1" })).toThrow();
    expect(() => estimateExecutionCosts({ ...base, grossProfitUsdCents: "1.2" })).toThrow();
    expect(() => estimateExecutionCosts({ ...base, swapFeeBps: 10000 })).toThrow();
  });

  it("marks negative net results as not profitable", () => {
    const result = estimateExecutionCosts({
      grossProfitUsdCents: "10", gasLimit: "1000000",
      maxFeePerGasWei: "100000000000", nativeAssetPriceUsdWad: "3000000000000000000000",
      flashLoanPrincipalUsdCents: "10000", flashLoanFeeBps: 50,
      swapNotionalUsdCents: "10000", swapFeeBps: 100, slippageBps: 100,
      builderFeeUsdCents: "100", safetyBufferBps: 500
    });
    expect(result.estimatedNetProfitUsdCents.startsWith("-")).toBe(true);
    expect(result.profitableBeforeForkSimulation).toBe(false);
  });
});
