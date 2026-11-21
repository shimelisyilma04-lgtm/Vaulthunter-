import { describe, expect, it } from "vitest";
import { morphoTaylorCompounded } from "../src/morpho/blue.js";

const WAD = 10n ** 18n;

describe("Morpho Blue Taylor-compounded interest", () => {
  it("returns zero for a zero rate or zero elapsed time", () => {
    expect(morphoTaylorCompounded(0n, 100n)).toBe(0n);
    expect(morphoTaylorCompounded(WAD / 100_000n, 0n)).toBe(0n);
  });

  it("includes higher-order Taylor terms beyond simple interest", () => {
    const rate = WAD / 100_000n;
    const elapsed = 3_600n;
    const x = rate * elapsed;
    const x2 = x * x / WAD;
    const x3 = x2 * x / WAD;
    const x4 = x3 * x / WAD;
    const x5 = x4 * x / WAD;
    const expected = x + x2 / 2n + x3 / 6n + x4 / 24n + x5 / 120n;
    expect(morphoTaylorCompounded(rate, elapsed)).toBe(expected);
    expect(morphoTaylorCompounded(rate, elapsed)).toBeGreaterThan(x);
  });

  it("is monotonic with elapsed time for a non-negative rate", () => {
    const rate = WAD / 1_000_000n;
    expect(morphoTaylorCompounded(rate, 3_600n))
      .toBeLessThan(morphoTaylorCompounded(rate, 7_200n));
  });
});
