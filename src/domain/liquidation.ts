export interface LiquidationCandidate {
  protocol: "aave-v3" | "morpho-blue";
  chainId: number;
  marketId: string;
  borrower: string;
  healthFactorWad: bigint;
  observedBlock: bigint;
}

export const WAD = 10n ** 18n;

/**
 * Aave-style health factor threshold helper.
 * This is only a screening predicate, not proof that a liquidation is executable.
 */
export function isBelowLiquidationThreshold(healthFactorWad: bigint): boolean {
  return healthFactorWad < WAD;
}
