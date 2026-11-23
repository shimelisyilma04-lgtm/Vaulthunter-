import { describe, expect, it } from "vitest";
import { rankMorphoOpportunities, scoreMorphoOpportunity } from "../src/morpho/opportunity-scoring.js";

describe("Morpho opportunity triage scoring", () => {
  it("rewards risk urgency, freshness, route, flash liquidity and positive pre-gas estimate", () => {
    const scored = scoreMorphoOpportunity({
      healthFactor: 0.92, snapshotAgeSeconds: 8,
      collateralExitQuote: { amountOut: "200" },
      funding: { sufficient: true, status: "reserve-liquidity-verified-at-snapshot" },
      profitability: { preGasProfitLoanToken: "10" }
    });
    expect(scored.priorityScore).toBe(95);
    expect(scored.priorityBand).toBe("high");
  });

  it("does not treat missing route, funding or profit data as positive signals", () => {
    const scored = scoreMorphoOpportunity({ healthFactor: 1.2, snapshotAgeSeconds: 55 });
    expect(scored.priorityScore).toBe(18);
    expect(scored.priorityBand).toBe("low");
  });

  it("sorts deterministically and adds one-based ranks", () => {
    const ranked = rankMorphoOpportunities([
      { borrower: "0xbbb", healthFactor: 1.1, snapshotAgeSeconds: 10 },
      { borrower: "0xaaa", healthFactor: 0.95, snapshotAgeSeconds: 10 }
    ]);
    expect(ranked[0]?.borrower).toBe("0xaaa");
    expect(ranked[0]?.priorityRank).toBe(1);
    expect(ranked[1]?.priorityRank).toBe(2);
  });

  it("never gives points for malformed token amount strings", () => {
    const scored = scoreMorphoOpportunity({
      healthFactor: 0.99, snapshotAgeSeconds: 10,
      collateralExitQuote: { amountOut: "1e18" },
      funding: { sufficient: true, status: "reserve-liquidity-verified-at-snapshot" },
      profitability: { preGasProfitLoanToken: "-100" }
    });
    expect(scored.priorityScore).toBe(65);
  });
});
