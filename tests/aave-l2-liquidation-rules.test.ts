import { describe, expect, it } from "vitest";
import {
  aaveL2CloseFactorBps,
  aaveL2DustSatisfied,
  aaveL2UsesEModePrice
} from "../src/aave/l2-reserve-positions.js";

const WAD = 10n ** 18n;

describe("Aave V3 L2 liquidation rules", () => {
  it("uses 50% close factor only above the account-wide threshold and HF 0.95", () => {
    expect(aaveL2CloseFactorBps(94n * WAD / 100n, 5_000n, 2_000n)).toBe(10_000n);
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 1_999n, 2_000n)).toBe(10_000n);
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 2_001n, 2_000n)).toBe(5_000n);
  });

  it("fails conservatively to the 50% close factor when the deployed threshold is unavailable", () => {
    expect(aaveL2CloseFactorBps(96n * WAD / 100n, 1n, null)).toBe(5_000n);
    expect(aaveL2CloseFactorBps(94n * WAD / 100n, 1n, null)).toBe(10_000n);
  });

  it("uses the eMode price source only for reserves in the user's active category", () => {
    const source = "0x0000000000000000000000000000000000000001";
    expect(aaveL2UsesEModePrice(1, 1, source)).toBe(true);
    expect(aaveL2UsesEModePrice(1, 2, source)).toBe(false);
    expect(aaveL2UsesEModePrice(0, 1, source)).toBe(false);
    expect(aaveL2UsesEModePrice(1, 1, "0x0000000000000000000000000000000000000000")).toBe(false);
  });

  it("requires known minimum leftovers unless one side is fully cleared", () => {
    expect(aaveL2DustSatisfied(1_000n, 1_000n, null, false, false)).toBe(false);
    expect(aaveL2DustSatisfied(1_000n, 1_000n, 1_000n, false, false)).toBe(true);
    expect(aaveL2DustSatisfied(0n, 0n, null, true, false)).toBe(true);
    expect(aaveL2DustSatisfied(0n, 0n, null, false, true)).toBe(true);
    expect(aaveL2DustSatisfied(999n, 2_000n, 1_000n, false, false)).toBe(false);
  });
});
