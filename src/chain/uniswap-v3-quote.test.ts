import { describe, expect, it } from "vitest";
import { quoteMultiChainUniswapV3, UNISWAP_V3_QUOTER_V2 } from "./uniswap-v3-quote.js";

describe("multi-chain Uniswap V3 quote adapter", () => {
  it("uses official Base and Arbitrum QuoterV2 deployments", () => {
    expect(UNISWAP_V3_QUOTER_V2.base.chainId).toBe(8453);
    expect(UNISWAP_V3_QUOTER_V2.arbitrum.chainId).toBe(42161);
    expect(UNISWAP_V3_QUOTER_V2.base.address).toBe("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
    expect(UNISWAP_V3_QUOTER_V2.arbitrum.address).toBe("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");
  });

  it("rejects identical input and output tokens before making an RPC call", async () => {
    await expect(quoteMultiChainUniswapV3({
      network: "base", rpcUrl: "https://example.invalid",
      tokenIn: "0x0000000000000000000000000000000000000001",
      tokenOut: "0x0000000000000000000000000000000000000001",
      amountIn: "100"
    })).rejects.toThrow("tokenIn and tokenOut must differ");
  });

  it("rejects non-positive amounts before making an RPC call", async () => {
    await expect(quoteMultiChainUniswapV3({
      network: "arbitrum", rpcUrl: "https://example.invalid",
      tokenIn: "0x0000000000000000000000000000000000000001",
      tokenOut: "0x0000000000000000000000000000000000000002",
      amountIn: "0"
    })).rejects.toThrow("amountIn must be a positive integer");
  });
});
