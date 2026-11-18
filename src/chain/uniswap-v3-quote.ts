import { Contract, JsonRpcProvider, getAddress } from "ethers";

export const UNISWAP_V3_QUOTER_V2 = {
  base: { chainId: 8453, address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" },
  arbitrum: { chainId: 42161, address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" }
} as const;

const ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
] as const;

export async function quoteMultiChainUniswapV3(args: {
  network: keyof typeof UNISWAP_V3_QUOTER_V2;
  rpcUrl: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
}): Promise<{
  network: string;
  chainId: number;
  blockNumber: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  selectedFee: number | null;
  amountOut: string | null;
  gasEstimate: string | null;
  candidates: Array<{ fee: number; amountOut: string | null; gasEstimate: string | null; available: boolean; error?: string }>;
  source: "uniswap-v3-quoter-v2";
  executionEnabled: false;
  warning: string;
}> {
  const deployment = UNISWAP_V3_QUOTER_V2[args.network];
  const tokenIn = getAddress(args.tokenIn);
  const tokenOut = getAddress(args.tokenOut);
  if (tokenIn === tokenOut) throw new Error("tokenIn and tokenOut must differ");
  if (!/^\d+$/.test(args.amountIn) || BigInt(args.amountIn) <= 0n) {
    throw new Error("amountIn must be a positive integer in input-token base units");
  }
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(deployment.chainId)) {
      throw new Error(`Expected chain ${deployment.chainId}; received ${network.chainId}`);
    }
    const blockNumber = await provider.getBlockNumber();
    const quoter = new Contract(deployment.address, ABI, provider);
    const candidates = await Promise.all([100, 500, 3000, 10000].map(async (fee) => {
      try {
        const quote = await quoter.getFunction("quoteExactInputSingle").staticCall({
          tokenIn, tokenOut, fee, amountIn: BigInt(args.amountIn), sqrtPriceLimitX96: 0
        }, { blockTag: blockNumber }) as readonly [bigint, bigint, number, bigint];
        return { fee, amountOut: quote[0].toString(), gasEstimate: quote[3].toString(), available: true };
      } catch (error) {
        return { fee, amountOut: null, gasEstimate: null, available: false,
          error: error instanceof Error ? error.message.slice(0, 200) : "Pool unavailable" };
      }
    }));
    const valid = candidates.filter((item) => item.available && item.amountOut !== null);
    const best = valid.reduce<typeof valid[number] | null>((best, item) =>
      best === null || BigInt(item.amountOut!) > BigInt(best.amountOut!) ? item : best, null);
    return {
      network: args.network, chainId: deployment.chainId, blockNumber, tokenIn, tokenOut,
      amountIn: args.amountIn, selectedFee: best?.fee ?? null, amountOut: best?.amountOut ?? null,
      gasEstimate: best?.gasEstimate ?? null, candidates, source: "uniswap-v3-quoter-v2",
      executionEnabled: false,
      warning: "Same-block quote only. It is not a profitability result: token decimals/prices, liquidation bonus, flash-loan fee, gas price, route liquidity, slippage, MEV and full transaction simulation must still be included. No transaction is signed or submitted."
    };
  } finally {
    await provider.destroy();
  }
}
