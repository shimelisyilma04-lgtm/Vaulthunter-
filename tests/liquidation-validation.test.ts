import { describe, expect, it } from "vitest";
import { validateLiquidationCandidate, type LiquidationValidationInput } from "../src/domain/validation.js";

const complete: LiquidationValidationInput = {
  protocol: "morpho-blue",
  chainId: 1,
  expectedChainId: 1,
  observedBlock: 1000,
  currentHeadBlock: 1020,
  maxSnapshotAgeBlocks: 30,
  confirmations: 12,
  accountingBlock: 1000,
  oracleBlock: 1000,
  liquidityBlock: 1000,
  swapQuoteBlock: 1000,
  gasQuoteBlock: 1000,
  simulationBlock: 1000,
  exactInterestAccrualVerified: true,
  protocolLiquidationRulesVerified: true,
  oraclePriceVerified: true,
  availableLiquidityVerified: true,
  executableSwapQuoteVerified: true,
  gasCostVerified: true,
  simulationSucceeded: true,
  simulationReverted: false,
  expectedNetProfitUsdWad: "2000000000000000000",
  minimumNetProfitUsdWad: "1000000000000000000"
};

describe("validateLiquidationCandidate", () => {
  it("passes only complete same-block evidence to simulation review", () => {
    const result = validateLiquidationCandidate(complete);
    expect(result.status).toBe("simulation_review");
    expect(result.reasons).toEqual([]);
    expect(result.transactionAuthorized).toBe(false);
  });

  it("rejects stale position snapshots", () => {
    const result = validateLiquidationCandidate({ ...complete, observedBlock: 900 });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("stale_position_snapshot");
  });

  it("rejects mismatched source blocks", () => {
    const result = validateLiquidationCandidate({ ...complete, oracleBlock: 999 });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("oracle_block_mismatch");
  });

  it("rejects failed or reverted simulations", () => {
    const result = validateLiquidationCandidate({ ...complete, simulationSucceeded: false });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("transaction_simulation_failed_or_reverted");
  });

  it("requires missing protocol accounting and interest evidence", () => {
    const result = validateLiquidationCandidate({
      ...complete,
      exactInterestAccrualVerified: false,
      protocolLiquidationRulesVerified: false
    });
    expect(result.status).toBe("needs_data");
    expect(result.reasons).toContain("exact_interest_accrual_not_verified");
    expect(result.reasons).toContain("protocol_liquidation_rules_not_verified");
  });

  it("rejects profits below the configured minimum", () => {
    const result = validateLiquidationCandidate({
      ...complete,
      expectedNetProfitUsdWad: "999"
    });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("net_profit_below_minimum");
  });

  it("never authorizes a transaction", () => {
    const result = validateLiquidationCandidate(complete);
    expect(result.transactionAuthorized).toBe(false);
  });
});
