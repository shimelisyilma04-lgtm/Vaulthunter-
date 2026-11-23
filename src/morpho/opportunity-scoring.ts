export interface MorphoOpportunityScore {
  priorityScore: number;
  priorityBand: "high" | "medium" | "low";
  priorityReasons: string[];
}

function positiveIntegerString(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

/**
 * Deterministic triage score, not a profit prediction.
 * A high score only means a candidate deserves earlier revalidation/simulation.
 */
export function scoreMorphoOpportunity(row: Record<string, unknown>): MorphoOpportunityScore {
  let score = 0;
  const reasons: string[] = [];
  const healthFactor = typeof row.healthFactor === "number" && Number.isFinite(row.healthFactor)
    ? row.healthFactor : Number.POSITIVE_INFINITY;

  if (healthFactor <= 0.9) { score += 35; reasons.push("Severe liquidation risk: health factor at or below 0.90"); }
  else if (healthFactor < 1) { score += 30; reasons.push("Liquidatable health factor below 1.00"); }
  else if (healthFactor <= 1.05) { score += 25; reasons.push("Very close to liquidation threshold"); }
  else if (healthFactor <= 1.1) { score += 18; reasons.push("Elevated liquidation risk"); }
  else if (healthFactor <= 1.25) { score += 10; reasons.push("Within monitored risk band"); }

  const age = typeof row.snapshotAgeSeconds === "number" && Number.isFinite(row.snapshotAgeSeconds)
    ? row.snapshotAgeSeconds : Number.POSITIVE_INFINITY;
  if (age <= 15) { score += 20; reasons.push("Risk snapshot is very fresh"); }
  else if (age <= 30) { score += 15; reasons.push("Risk snapshot is fresh"); }
  else if (age <= 60) { score += 8; reasons.push("Risk snapshot is within freshness limit"); }

  const exitQuote = row.collateralExitQuote && typeof row.collateralExitQuote === "object"
    ? row.collateralExitQuote as Record<string, unknown> : null;
  const amountOut = positiveIntegerString(exitQuote?.amountOut);
  if (amountOut !== null && amountOut > 0n) {
    score += 15;
    reasons.push("Positive DEX exit quote exists at the validation snapshot");
  }

  const funding = row.funding && typeof row.funding === "object"
    ? row.funding as Record<string, unknown> : null;
  if (funding?.sufficient === true && funding.status === "reserve-liquidity-verified-at-snapshot") {
    score += 15;
    reasons.push("Aave flash-loan reserve liquidity was verified at the snapshot");
  }

  const profitability = row.profitability && typeof row.profitability === "object"
    ? row.profitability as Record<string, unknown> : null;
  const preGasProfit = positiveIntegerString(profitability?.preGasProfitLoanToken);
  if (preGasProfit !== null && preGasProfit > 0n) {
    score += 15;
    reasons.push("Pre-gas estimate is positive; gas and MEV are still unverified");
  }

  const priorityBand = score >= 75 ? "high" : score >= 45 ? "medium" : "low";
  if (reasons.length === 0) reasons.push("Insufficient validated signals; retain low priority");
  return { priorityScore: score, priorityBand, priorityReasons: reasons };
}

/** Stable ordering: score first, then lower health factor, then borrower address. */
export function rankMorphoOpportunities(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
    .map((row) => ({ ...row, ...scoreMorphoOpportunity(row) }))
    .sort((a, b) => {
      const scoreDelta = Number(b.priorityScore) - Number(a.priorityScore);
      if (scoreDelta !== 0) return scoreDelta;
      const ahf = typeof a.healthFactor === "number" ? a.healthFactor : Number.POSITIVE_INFINITY;
      const bhf = typeof b.healthFactor === "number" ? b.healthFactor : Number.POSITIVE_INFINITY;
      if (ahf !== bhf) return ahf - bhf;
      return String(a.borrower ?? "").localeCompare(String(b.borrower ?? ""));
    })
    .map((row, index) => ({ ...row, priorityRank: index + 1 }));
}
