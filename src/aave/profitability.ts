import { calculateNetProfit, type ProfitabilityResult } from "../domain/profitability.js";

export interface AaveProfitabilityInput {
  /** Estimated debt repayment value, denominated in USD WAD. */
  debtToCoverUsdWad: bigint;
  /** Reserve liquidation bonus, in basis points above 100%; e.g. 10500 = 5% bonus. */
  liquidationBonusBps: bigint;
  gasCostUsdWad: bigint;
  swapCostUsdWad: bigint;
  flashLoanFeeUsdWad: bigint;
  builderFeeUsdWad: bigint;
  safetyMarginUsdWad: bigint;
}

export interface AaveProfitabilityResult extends ProfitabilityResult {
  grossCollateralValueUsdWad: bigint;
  grossProfitUsdWad: bigint;
}

/**
 * Estimates the value of the collateral received for a debt repayment.
 * Inputs must be conservative USD-WAD estimates from the same valuation source.
 * This is an economic screen only: it does not determine close factor, collateral
 * availability, protocol caps, swap execution price, or transaction success.
 */
export function estimateAaveLiquidationProfit(input: AaveProfitabilityInput): AaveProfitabilityResult {
  if (input.debtToCoverUsdWad <= 0n) throw new Error("Debt to cover must be positive");
  if (input.liquidationBonusBps < 10000n) throw new Error("Liquidation bonus must be at least 10000 bps");
  const grossCollateralValueUsdWad =
    input.debtToCoverUsdWad * input.liquidationBonusBps / 10000n;
  const grossProfitUsdWad = grossCollateralValueUsdWad - input.debtToCoverUsdWad;
  const result = calculateNetProfit({
    grossProfit: grossCollateralValueUsdWad,
    debtRepaymentCost: input.debtToCoverUsdWad,
    swapCost: input.swapCostUsdWad,
    gasCost: input.gasCostUsdWad,
    flashLoanFee: input.flashLoanFeeUsdWad,
    builderFee: input.builderFeeUsdWad,
    safetyMargin: input.safetyMarginUsdWad
  });
  return { ...result, grossCollateralValueUsdWad, grossProfitUsdWad };
}
