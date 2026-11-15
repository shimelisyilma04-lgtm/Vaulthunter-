const WAD = 10n ** 18n;
const CENT_IN_USD_WAD = 10n ** 16n;
const BPS = 10_000n;

export interface ExecutionCostInput {
  grossProfitUsdCents: string;
  gasLimit: string;
  maxFeePerGasWei: string;
  nativeAssetPriceUsdWad: string;
  flashLoanPrincipalUsdCents: string;
  flashLoanFeeBps: number;
  swapNotionalUsdCents: string;
  swapFeeBps: number;
  slippageBps: number;
  builderFeeUsdCents: string;
  safetyBufferBps: number;
}

export interface ExecutionCostResult {
  denomination: "USD cents";
  gasCostUsdCents: string;
  flashLoanFeeUsdCents: string;
  swapAndSlippageCostUsdCents: string;
  builderFeeUsdCents: string;
  safetyBufferUsdCents: string;
  totalEstimatedCostsUsdCents: string;
  estimatedNetProfitUsdCents: string;
  profitableBeforeForkSimulation: boolean;
  assumptions: string[];
  warnings: string[];
}

function unsignedInteger(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 100) {
    throw new Error(name + " must be a non-negative integer string");
  }
  return BigInt(value);
}

function basisPoints(value: number, name: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value >= 10_000) {
    throw new Error(name + " must be an integer from 0 to 9999");
  }
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/**
 * Conservative execution-cost budget. All outputs are USD cents.
 * maxFeePerGasWei is used rather than the current base fee to avoid
 * understating the user's maximum EIP-1559 gas exposure.
 */
export function estimateExecutionCosts(input: ExecutionCostInput): ExecutionCostResult {
  const grossProfit = unsignedInteger(input.grossProfitUsdCents, "grossProfitUsdCents");
  const gasLimit = unsignedInteger(input.gasLimit, "gasLimit");
  const maxFeePerGasWei = unsignedInteger(input.maxFeePerGasWei, "maxFeePerGasWei");
  const nativePriceUsdWad = unsignedInteger(input.nativeAssetPriceUsdWad, "nativeAssetPriceUsdWad");
  const flashPrincipal = unsignedInteger(input.flashLoanPrincipalUsdCents, "flashLoanPrincipalUsdCents");
  const swapNotional = unsignedInteger(input.swapNotionalUsdCents, "swapNotionalUsdCents");
  const builderFee = unsignedInteger(input.builderFeeUsdCents, "builderFeeUsdCents");
  const flashFeeBps = basisPoints(input.flashLoanFeeBps, "flashLoanFeeBps");
  const swapFeeBps = basisPoints(input.swapFeeBps, "swapFeeBps");
  const slippageBps = basisPoints(input.slippageBps, "slippageBps");
  const safetyBps = basisPoints(input.safetyBufferBps, "safetyBufferBps");

  const gasWei = gasLimit * maxFeePerGasWei;
  const gasUsdWad = ceilDiv(gasWei * nativePriceUsdWad, WAD);
  const gasCostUsdCents = ceilDiv(gasUsdWad, CENT_IN_USD_WAD);
  const flashLoanFeeUsdCents = ceilDiv(flashPrincipal * flashFeeBps, BPS);
  const swapAndSlippageCostUsdCents = ceilDiv(swapNotional * (swapFeeBps + slippageBps), BPS);
  const safetyBufferUsdCents = ceilDiv(grossProfit * safetyBps, BPS);
  const totalEstimatedCosts = gasCostUsdCents + flashLoanFeeUsdCents +
    swapAndSlippageCostUsdCents + builderFee + safetyBufferUsdCents;
  const estimatedNetProfit = grossProfit - totalEstimatedCosts;

  return {
    denomination: "USD cents",
    gasCostUsdCents: gasCostUsdCents.toString(),
    flashLoanFeeUsdCents: flashLoanFeeUsdCents.toString(),
    swapAndSlippageCostUsdCents: swapAndSlippageCostUsdCents.toString(),
    builderFeeUsdCents: builderFee.toString(),
    safetyBufferUsdCents: safetyBufferUsdCents.toString(),
    totalEstimatedCostsUsdCents: totalEstimatedCosts.toString(),
    estimatedNetProfitUsdCents: estimatedNetProfit.toString(),
    profitableBeforeForkSimulation: estimatedNetProfit > 0n,
    assumptions: [
      "All USD-cent inputs and the native-asset USD price must refer to the same market snapshot.",
      "Gas is budgeted at gasLimit multiplied by maxFeePerGasWei, not the current spot gas price.",
      "Flash-loan, swap, slippage, builder and safety costs are rounded up conservatively."
    ],
    warnings: [
      "This is a cost budget, not an executable quote or profit guarantee.",
      "It excludes failed-transaction costs, state drift, MEV competition, oracle changes and protocol-specific edge cases.",
      "A positive result must still pass full fork simulation and independent review."
    ]
  };
}
