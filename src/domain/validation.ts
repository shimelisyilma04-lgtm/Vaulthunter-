/**
 * Fail-closed validation gates for liquidation research.
 *
 * This module can classify a candidate as suitable for further simulation review.
 * It deliberately cannot authorize signing or transaction submission.
 */
export type ValidationStatus = "rejected" | "needs_data" | "simulation_review";

export interface LiquidationValidationInput {
  protocol: "aave-v3" | "morpho-blue";
  chainId: number;
  expectedChainId: number;
  observedBlock: number;
  currentHeadBlock: number;
  maxSnapshotAgeBlocks: number;
  confirmations: number;
  accountingBlock: number | null;
  oracleBlock: number | null;
  liquidityBlock: number | null;
  swapQuoteBlock: number | null;
  gasQuoteBlock: number | null;
  simulationBlock: number | null;
  exactInterestAccrualVerified: boolean;
  protocolLiquidationRulesVerified: boolean;
  oraclePriceVerified: boolean;
  availableLiquidityVerified: boolean;
  executableSwapQuoteVerified: boolean;
  gasCostVerified: boolean;
  simulationSucceeded: boolean;
  simulationReverted: boolean;
  expectedNetProfitUsdWad: string | null;
  minimumNetProfitUsdWad: string;
}

export interface LiquidationValidationResult {
  status: ValidationStatus;
  reasons: string[];
  observedBlock: number;
  /** Always false: this validator never authorizes a transaction. */
  transactionAuthorized: false;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Conservative, fail-closed checks. "simulation_review" means only that the
 * supplied evidence passed these software gates; it is not a safety guarantee.
 */
export function validateLiquidationCandidate(
  input: LiquidationValidationInput
): LiquidationValidationResult {
  const reasons: string[] = [];
  const reject = (reason: string) => reasons.push(reason);
  const needs = (reason: string) => reasons.push(reason);

  if (input.chainId !== input.expectedChainId) reject("wrong_chain");
  if (![input.chainId, input.expectedChainId, input.observedBlock, input.currentHeadBlock,
    input.maxSnapshotAgeBlocks, input.confirmations].every(isNonNegativeInteger)) {
    reject("invalid_block_or_chain_metadata");
  }
  if (input.observedBlock > input.currentHeadBlock) reject("observed_block_is_in_future");
  if (input.currentHeadBlock - input.observedBlock > input.maxSnapshotAgeBlocks) reject("stale_position_snapshot");
  if (input.currentHeadBlock - input.observedBlock < input.confirmations) reject("insufficient_confirmations");

  const requiredBlocks: Array<[string, number | null]> = [
    ["accounting", input.accountingBlock],
    ["oracle", input.oracleBlock],
    ["liquidity", input.liquidityBlock],
    ["swap_quote", input.swapQuoteBlock],
    ["gas_quote", input.gasQuoteBlock],
    ["simulation", input.simulationBlock]
  ];
  for (const [label, block] of requiredBlocks) {
    if (block === null) needs(`missing_${label}_block`);
    else if (block !== input.observedBlock) reject(`${label}_block_mismatch`);
  }

  if (!input.exactInterestAccrualVerified) needs("exact_interest_accrual_not_verified");
  if (!input.protocolLiquidationRulesVerified) needs("protocol_liquidation_rules_not_verified");
  if (!input.oraclePriceVerified) needs("oracle_price_not_verified");
  if (!input.availableLiquidityVerified) needs("available_liquidity_not_verified");
  if (!input.executableSwapQuoteVerified) needs("executable_swap_quote_not_verified");
  if (!input.gasCostVerified) needs("gas_cost_not_verified");
  if (!input.simulationSucceeded || input.simulationReverted) reject("transaction_simulation_failed_or_reverted");

  let expectedProfit: bigint | null = null;
  let minimumProfit: bigint | null = null;
  try {
    if (input.expectedNetProfitUsdWad === null) throw new Error("missing");
    expectedProfit = BigInt(input.expectedNetProfitUsdWad);
    minimumProfit = BigInt(input.minimumNetProfitUsdWad);
    if (expectedProfit < minimumProfit) reject("net_profit_below_minimum");
  } catch {
    needs("net_profit_estimate_missing_or_invalid");
  }

  const hasReject = reasons.some((reason) =>
    reason === "wrong_chain" ||
    reason === "invalid_block_or_chain_metadata" ||
    reason === "observed_block_is_in_future" ||
    reason === "stale_position_snapshot" ||
    reason === "insufficient_confirmations" ||
    reason.endsWith("_block_mismatch") ||
    reason === "transaction_simulation_failed_or_reverted" ||
    reason === "net_profit_below_minimum"
  );
  return {
    status: hasReject ? "rejected" : reasons.length > 0 ? "needs_data" : "simulation_review",
    reasons,
    observedBlock: input.observedBlock,
    transactionAuthorized: false
  };
}
