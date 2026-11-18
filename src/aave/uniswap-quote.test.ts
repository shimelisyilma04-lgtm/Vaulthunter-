import { describe, expect, it } from "vitest";
import { enumerateUniswapV3FeeTiers } from "./uniswap-quote.js";

describe("enumerateUniswapV3FeeTiers", () => {
  it("enumerates 4, 16 and 64 fee-tier paths for one to three hops", () => {
    expect(enumerateUniswapV3FeeTiers(1)).toHaveLength(4);
    expect(enumerateUniswapV3FeeTiers(2)).toHaveLength(16);
    expect(enumerateUniswapV3FeeTiers(3)).toHaveLength(64);
    expect(enumerateUniswapV3FeeTiers(3).every((path) => path.length === 3)).toBe(true);
  });

  it("rejects unbounded route lengths", () => {
    expect(() => enumerateUniswapV3FeeTiers(0)).toThrow();
    expect(() => enumerateUniswapV3FeeTiers(4)).toThrow();
  });
});
