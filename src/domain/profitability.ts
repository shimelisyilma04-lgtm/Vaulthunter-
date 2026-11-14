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

export interface AaveV3EstimateInput {
  healthFactor: number;
  totalDebtUsd: number;
  debtReserveUsd: number;
  collateralReserveUsd: number;
  collateralAvailableUsd: number;
  liquidationBonusBps: number;
  gasCostUsd: number;
  flashLoanFeeBps?: number;
  swapFeeBps?: number;
  slippageBps?: number;
  protocolFeeBps?: number;
  safetyBufferBps?: number;
}

export interface AaveV3Estimate {
  protocol: "aave-v3";
  eligibleByHealthFactor: boolean;
  closeFactorBps: 0 | 5000 | 10000;
  maxRepayUsd: number;
  collateralSeizedUsd: number;
  grossBonusUsd: number;
  protocolFeeUsd: number;
  flashLoanFeeUsd: number;
  swapCostUsd: number;
  gasCostUsd: number;
  safetyBufferUsd: number;
  estimatedNetProfitUsd: number;
  profitableBeforeExecutionChecks: boolean;
  assumptions: string[];
  warnings: string[];
}

const BPS = 10_000;
const MIN_RESIDUAL_USD = 1_000;
const FULL_CLOSE_HF = 0.95;
const SMALL_POSITION_USD = 2_000;

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

function validateBps(value: number, name: string): number {
  finiteNonNegative(value, name);
  if (!Number.isInteger(value) || value >= BPS) {
    throw new Error(`${name} must be an integer from 0 to 9999 basis points`);
  }
  return value;
}

/**
 * Conservative, read-only Aave V3 screening estimate.
 * Values must be fresh, same-block, pair-specific inputs from a market adapter.
 * This is not an execution simulation or a profit guarantee.
 */
export function estimateAaveV3Liquidation(input: AaveV3EstimateInput): AaveV3Estimate {
  const healthFactor = finiteNonNegative(input.healthFactor, "healthFactor");
  const totalDebtUsd = finiteNonNegative(input.totalDebtUsd, "totalDebtUsd");
  const debtReserveUsd = finiteNonNegative(input.debtReserveUsd, "debtReserveUsd");
  const collateralReserveUsd = finiteNonNegative(input.collateralReserveUsd, "collateralReserveUsd");
  const collateralAvailableUsd = finiteNonNegative(input.collateralAvailableUsd, "collateralAvailableUsd");
  const bonusBps = validateBps(input.liquidationBonusBps, "liquidationBonusBps");
  const gasCostUsd = finiteNonNegative(input.gasCostUsd, "gasCostUsd");
  const flashFeeBps = validateBps(input.flashLoanFeeBps ?? 0, "flashLoanFeeBps");
  const swapFeeBps = validateBps(input.swapFeeBps ?? 0, "swapFeeBps");
  const slippageBps = validateBps(input.slippageBps ?? 0, "slippageBps");
  const protocolFeeBps = validateBps(input.protocolFeeBps ?? 0, "protocolFeeBps");
  const safetyBufferBps = validateBps(input.safetyBufferBps ?? 500, "safetyBufferBps");

  const assumptions = [
    "USD values and reserve parameters are caller-supplied; no market quote is invented.",
    "All inputs must refer to the same recent block and the selected Aave V3 Ethereum market.",
    "Swap fee and slippage are applied to estimated collateral proceeds.",
    "Protocol fee is modelled against the liquidation bonus.",
    "Failed-transaction costs, MEV competition, and route-specific execution effects are excluded."
  ];
  const warnings = [
    "Re-read borrower and reserve state at one pinned block before acting.",
    "Run exact fork/on-chain simulation and verify route liquidity, oracle state, caps, and gas.",
    "A positive estimate is not a profit guarantee. VaultHunter never signs or submits transactions."
  ];

  if (healthFactor <= 0 || totalDebtUsd === 0 || healthFactor >= 1) {
    return {
      protocol: "aave-v3", eligibleByHealthFactor: false, closeFactorBps: 0,
      maxRepayUsd: 0, collateralSeizedUsd: 0, grossBonusUsd: 0,
      protocolFeeUsd: 0, flashLoanFeeUsd: 0, swapCostUsd: 0, gasCostUsd,
      safetyBufferUsd: 0, estimatedNetProfitUsd: -gasCostUsd,
      profitableBeforeExecutionChecks: false, assumptions, warnings
    };
  }

  // Aave V3 permits up to 100% when HF <= 0.95 or either selected reserve
  // position is below $2,000; otherwise the standard close factor is 50%.
  const fullClose = healthFactor <= FULL_CLOSE_HF ||
    debtReserveUsd < SMALL_POSITION_USD ||
    collateralReserveUsd < SMALL_POSITION_USD;
  const closeFactorBps: 0 | 5000 | 10000 = fullClose ? 10_000 : 5_000;
  const closeFactorCap = totalDebtUsd * closeFactorBps / BPS;
  const residualDebtCap = fullClose ? totalDebtUsd : Math.max(0, totalDebtUsd - MIN_RESIDUAL_USD);
  const residualCollateralCap = fullClose
    ? collateralAvailableUsd
    : Math.max(0, collateralAvailableUsd - MIN_RESIDUAL_USD);
  const collateralCap = residualCollateralCap / (1 + bonusBps / BPS);
  const maxRepayUsd = Math.max(0, Math.min(closeFactorCap, residualDebtCap, collateralCap));
  const grossBonusUsd = maxRepayUsd * bonusBps / BPS;
  const collateralSeizedUsd = maxRepayUsd + grossBonusUsd;
  const protocolFeeUsd = grossBonusUsd * protocolFeeBps / BPS;
  const flashLoanFeeUsd = maxRepayUsd * flashFeeBps / BPS;
  const swapCostUsd = collateralSeizedUsd * (swapFeeBps + slippageBps) / BPS;
  const safetyBufferUsd = grossBonusUsd * safetyBufferBps / BPS;
  const estimatedNetProfitUsd = grossBonusUsd - protocolFeeUsd - flashLoanFeeUsd -
    swapCostUsd - gasCostUsd - safetyBufferUsd;

  return {
    protocol: "aave-v3", eligibleByHealthFactor: true, closeFactorBps,
    maxRepayUsd, collateralSeizedUsd, grossBonusUsd, protocolFeeUsd,
    flashLoanFeeUsd, swapCostUsd, gasCostUsd, safetyBufferUsd,
    estimatedNetProfitUsd,
    profitableBeforeExecutionChecks: maxRepayUsd > 0 && estimatedNetProfitUsd > 0,
    assumptions, warnings
  };
}
