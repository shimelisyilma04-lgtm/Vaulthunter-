export interface NetProfitInput {
  swapProceeds: string;
  repayment: string;
  flashLoanFee: string;
  gasCost: string;
  mevBudget: string;
  builderFee: string;
  safetyBuffer: string;
  slippageBps: number;
}
export interface NetProfitResult {
  slippageAdjustedSwapProceeds: string;
  slippageHaircut: string;
  repayment: string;
  flashLoanFee: string;
  gasCost: string;
  mevBudget: string;
  builderFee: string;
  safetyBuffer: string;
  netProfit: string;
  positive: boolean;
}
function uint(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new Error(label + " must be an unsigned integer string");
  }
  return BigInt(value);
}
/** All monetary values must be in the same token's base units and one snapshot. */
export function calculateNetProfit(input: NetProfitInput): NetProfitResult {
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) {
    throw new Error("slippageBps must be an integer from 0 to 9999");
  }
  const proceeds = uint(input.swapProceeds, "swapProceeds");
  const repayment = uint(input.repayment, "repayment");
  const flashLoanFee = uint(input.flashLoanFee, "flashLoanFee");
  const gasCost = uint(input.gasCost, "gasCost");
  const mevBudget = uint(input.mevBudget, "mevBudget");
  const builderFee = uint(input.builderFee, "builderFee");
  const safetyBuffer = uint(input.safetyBuffer, "safetyBuffer");
  const adjusted = proceeds * BigInt(10_000 - input.slippageBps) / 10_000n;
  const haircut = proceeds - adjusted;
  const net = adjusted - repayment - flashLoanFee - gasCost - mevBudget - builderFee - safetyBuffer;
  return {
    slippageAdjustedSwapProceeds: adjusted.toString(),
    slippageHaircut: haircut.toString(),
    repayment: repayment.toString(),
    flashLoanFee: flashLoanFee.toString(),
    gasCost: gasCost.toString(),
    mevBudget: mevBudget.toString(),
    builderFee: builderFee.toString(),
    safetyBuffer: safetyBuffer.toString(),
    netProfit: net.toString(),
    positive: net > 0n
  };
}
