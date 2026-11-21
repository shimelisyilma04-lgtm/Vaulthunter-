import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { enumerateUniswapV3FeeTiers } from "./uniswap-quote.js";
import { UNISWAP_V3_QUOTER_V2_ABI } from "../chain/uniswap-v3-quote.js";

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


describe("Uniswap V3 QuoterV2 ABI", () => {
  it("exposes both single-hop and packed multi-hop quote functions", () => {
    const iface = new Interface(UNISWAP_V3_QUOTER_V2_ABI);
    expect(iface.getFunction("quoteExactInputSingle")).not.toBeNull();
    expect(iface.getFunction("quoteExactInput")).not.toBeNull();
  });
});
