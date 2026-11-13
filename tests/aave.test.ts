import { describe, expect, it } from "vitest";
import { isLiquidationEligible } from "../src/aave/scanner.js";
import { WAD } from "../src/domain/liquidation.js";

describe("Aave liquidation eligibility screening", () => {
  it("accepts positive health factors below one", () => {
    expect(isLiquidationEligible(WAD - 1n)).toBe(true);
  });

  it("rejects health factors at or above one", () => {
    expect(isLiquidationEligible(WAD)).toBe(false);
    expect(isLiquidationEligible(WAD + 1n)).toBe(false);
  });

  it("rejects zero health factor because it indicates no active debt", () => {
    expect(isLiquidationEligible(0n)).toBe(false);
  });
});
