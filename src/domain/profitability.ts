export interface ProfitabilityInput {
  grossProfit: bigint;
  debtRepaymentCost: bigint;
  swapCost: bigint;
  gasCost: bigint;
  flashLoanFee: bigint;
  builderFee: bigint;
  safetyMargin: bigint;
}

export interface ProfitabilityResult {
  netProfit: bigint;
  isCandidate: boolean;
}

/**
 * All values must use the same denomination and integer base units.
 * The caller is responsible for converting estimates conservatively.
 */
export function calculateNetProfit(input: ProfitabilityInput): ProfitabilityResult {
  const costs =
    input.debtRepaymentCost +
    input.swapCost +
    input.gasCost +
    input.flashLoanFee +
    input.builderFee +
    input.safetyMargin;

  const netProfit = input.grossProfit - costs;

  return {
    netProfit,
    isCandidate: netProfit > 0n
  };
}
