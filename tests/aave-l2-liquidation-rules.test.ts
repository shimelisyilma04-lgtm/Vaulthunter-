import { describe, expect, it } from "vitest";
import {
  aaveL2CloseFactorBps,
  aaveL2DustSatisfied,
  aaveL2UsesEModePrice,
  aavePercentDivFloor,
  aavePercentMulCeil,
  aavePercentMulFloor,
  aavePercentMulHalfUp
} from "../src/aave/l2-reserve-positions.js";

const WAD = 10n ** 18n;

describe("Aave V3 L2 liquidation rules", () => {
  it("uses the 50% close factor only when both selected reserves meet the threshold and HF is above 0.95", () => {
    expect(aaveL2CloseFactorBps(94n * WAD / 100n, 5_000n, 5_000n, 2_000n)).toBe(10_000n);
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 1_999n, 5_000n, 2_000n)).toBe(10_000n);
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 2_001n, 2_001n, 2_000n)).toBe(5_000n);
  });

  it("withholds pair sizing when the deployed close-factor threshold cannot be read", () => {
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 10_000n, 10_000n, null)).toBeNull();
  });

  it("does not apply the 50% cap unless both reserve values meet the threshold", () => {
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 2_000n, 1_999n, 2_000n)).toBe(10_000n);
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 1_999n, 2_000n, 2_000n)).toBe(10_000n);
  });

  it("uses eMode price for all debt reserves but only matching-category collateral reserves", () => {
    const source = "0x0000000000000000000000000000000000000001";
    expect(aaveL2UsesEModePrice(1, 1, source, true)).toBe(true);
    expect(aaveL2UsesEModePrice(1, 2, source, true)).toBe(false);
    expect(aaveL2UsesEModePrice(1, 2, source, false)).toBe(true);
    expect(aaveL2UsesEModePrice(0, 1, source, false)).toBe(false);
    expect(aaveL2UsesEModePrice(1, 1, "0x0000000000000000000000000000000000000000", true)).toBe(false);
  });

  it("matches Aave explicit floor, half-up and ceil percentage rounding", () => {
    expect(aavePercentMulHalfUp(1n, 5_000n)).toBe(1n);
    expect(aavePercentMulFloor(1n, 5_000n)).toBe(0n);
    expect(aavePercentMulCeil(1n, 1n)).toBe(1n);
    expect(aavePercentDivFloor(1n, 20_000n)).toBe(0n);
    expect(() => aavePercentDivFloor(1n, 0n)).toThrow();
  });

  it("requires known minimum leftovers unless one side is fully cleared", () => {
    expect(aaveL2DustSatisfied(1_000n, 1_000n, null, false, false)).toBe(false);
    expect(aaveL2DustSatisfied(1_000n, 1_000n, 1_000n, false, false)).toBe(true);
    expect(aaveL2DustSatisfied(0n, 0n, null, true, false)).toBe(true);
    expect(aaveL2DustSatisfied(0n, 0n, null, false, true)).toBe(true);
    expect(aaveL2DustSatisfied(999n, 2_000n, 1_000n, false, false)).toBe(false);
  });
});
