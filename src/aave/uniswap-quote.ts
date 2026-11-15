import { Contract, JsonRpcProvider, getAddress, solidityPacked } from "ethers";

const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)"
] as const;

export interface UniswapV3QuoteInput {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee: number;
}

export async function quoteUniswapV3ExactInput(
  rpcUrl: string,
  input: UniswapV3QuoteInput
): Promise<{
  chainId: 1;
  blockNumber: number;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  amountOut: string;
  gasEstimate: string;
  initializedTicksCrossed: number;
  source: "uniswap-v3-quoter-v2";
  executionEnabled: false;
  warning: string;
}> {
  const tokenIn = getAddress(input.tokenIn);
  const tokenOut = getAddress(input.tokenOut);
  if (tokenIn === tokenOut) throw new Error("tokenIn and tokenOut must be different addresses");
  if (!/^\d+$/.test(input.amountIn) || BigInt(input.amountIn) <= 0n) {
    throw new Error("amountIn must be a positive integer in the input token's smallest units");
  }
  if (!Number.isInteger(input.fee) || ![100, 500, 3000, 10000].includes(input.fee)) {
    throw new Error("fee must be one of the supported Uniswap V3 tiers: 100, 500, 3000, or 10000");
  }

  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error("Uniswap V3 quote adapter requires Ethereum mainnet (chain ID 1)");
    const blockNumber = await provider.getBlockNumber();
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
    const quote = await quoter.getFunction("quoteExactInputSingle").staticCall({
      tokenIn,
      tokenOut,
      fee: input.fee,
      amountIn: BigInt(input.amountIn),
      sqrtPriceLimitX96: 0
    }, { blockTag: blockNumber }) as readonly [bigint, bigint, number, bigint];
    return {
      chainId: 1,
      blockNumber,
      tokenIn,
      tokenOut,
      fee: input.fee,
      amountIn: input.amountIn,
      amountOut: quote[0].toString(),
      gasEstimate: quote[3].toString(),
      initializedTicksCrossed: Number(quote[2]),
      source: "uniswap-v3-quoter-v2",
      executionEnabled: false,
      warning: "This is a single-pool Uniswap V3 quote at one block, not a guaranteed executable route. It excludes Aave liquidation constraints, flash-loan fees, gas price, builder/MEV costs, and slippage after the quote. Revalidate and simulate the complete transaction separately."
    };
  } finally {
    await provider.destroy();
  }
}


export async function quoteUniswapV3BestExactInput(
  rpcUrl: string,
  input: Omit<UniswapV3QuoteInput, "fee">
): Promise<{
  chainId: 1;
  blockNumber: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  selectedFee: number | null;
  amountOut: string | null;
  gasEstimate: string | null;
  initializedTicksCrossed: number | null;
  candidates: Array<{
    fee: number;
    amountOut: string | null;
    gasEstimate: string | null;
    initializedTicksCrossed: number | null;
    available: boolean;
    error?: string;
  }>;
  source: "uniswap-v3-quoter-v2";
  executionEnabled: false;
  warning: string;
}> {
  const tokenIn = getAddress(input.tokenIn);
  const tokenOut = getAddress(input.tokenOut);
  if (tokenIn === tokenOut) throw new Error("tokenIn and tokenOut must be different addresses");
  if (!/^\d+$/.test(input.amountIn) || BigInt(input.amountIn) <= 0n) {
    throw new Error("amountIn must be a positive integer in the input token's smallest units");
  }

  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error("Uniswap V3 quote adapter requires Ethereum mainnet (chain ID 1)");
    const blockNumber = await provider.getBlockNumber();
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
    const fees = [100, 500, 3000, 10000] as const;
    const candidates = await Promise.all(fees.map(async (fee) => {
      try {
        const quote = await quoter.getFunction("quoteExactInputSingle").staticCall({
          tokenIn,
          tokenOut,
          fee,
          amountIn: BigInt(input.amountIn),
          sqrtPriceLimitX96: 0
        }, { blockTag: blockNumber }) as readonly [bigint, bigint, number, bigint];
        return {
          fee,
          amountOut: quote[0].toString(),
          gasEstimate: quote[3].toString(),
          initializedTicksCrossed: Number(quote[2]),
          available: true as const
        };
      } catch (error) {
        return {
          fee,
          amountOut: null,
          gasEstimate: null,
          initializedTicksCrossed: null,
          available: false as const,
          error: error instanceof Error ? error.message.slice(0, 240) : "Pool unavailable or quote failed"
        };
      }
    }));
    const available = candidates.filter((candidate) => candidate.available && candidate.amountOut !== null);
    const best = available.reduce<typeof available[number] | null>((current, candidate) =>
      current === null || BigInt(candidate.amountOut!) > BigInt(current.amountOut!) ? candidate : current, null);

    return {
      chainId: 1,
      blockNumber,
      tokenIn,
      tokenOut,
      amountIn: input.amountIn,
      selectedFee: best?.fee ?? null,
      amountOut: best?.amountOut ?? null,
      gasEstimate: best?.gasEstimate ?? null,
      initializedTicksCrossed: best?.initializedTicksCrossed ?? null,
      candidates,
      source: "uniswap-v3-quoter-v2",
      executionEnabled: false,
      warning: "All four standard Uniswap V3 fee tiers were quoted at the same block. The highest raw output is not necessarily the most profitable route: gas, flash-loan fees, liquidation rules, slippage, liquidity changes, MEV and full transaction simulation are excluded. No transaction is signed or submitted."
    };
  } finally {
    await provider.destroy();
  }
}


export async function quoteUniswapV3BestPath(
  rpcUrl: string,
  input: { tokens: string[]; amountIn: string }
): Promise<{
  chainId: 1;
  blockNumber: number;
  tokens: string[];
  amountIn: string;
  selectedFees: number[] | null;
  amountOut: string | null;
  gasEstimate: string | null;
  candidatesChecked: number;
  candidates: Array<{ fees: number[]; amountOut: string | null; gasEstimate: string | null; available: boolean; error?: string }>;
  source: "uniswap-v3-quoter-v2-multi-hop";
  executionEnabled: false;
  warning: string;
}> {
  if (input.tokens.length < 2 || input.tokens.length > 4) {
    throw new Error("A route must contain 2 to 4 token addresses (1 to 3 hops)");
  }
  const tokens = input.tokens.map(getAddress);
  if (new Set(tokens.map((token) => token.toLowerCase())).size !== tokens.length) {
    throw new Error("A route cannot repeat a token address");
  }
  if (!/^\\d+$/.test(input.amountIn) || BigInt(input.amountIn) <= 0n) {
    throw new Error("amountIn must be a positive integer in the input token's smallest units");
  }
  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error("Uniswap V3 path quotes require Ethereum mainnet (chain ID 1)");
    const blockNumber = await provider.getBlockNumber();
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
    const tiers = [100, 500, 3000, 10000] as const;
    const combinations: number[][] = [[]];
    for (let hop = 0; hop < tokens.length - 1; hop++) {
      const expanded: number[][] = [];
      for (const prefix of combinations) for (const fee of tiers) expanded.push([...prefix, fee]);
      combinations.splice(0, combinations.length, ...expanded);
    }
    const candidates = await Promise.all(combinations.map(async (fees) => {
      try {
        const types: string[] = ["address"];
        const values: Array<string | number> = [tokens[0]!];
        for (let i = 0; i < fees.length; i++) {
          types.push("uint24", "address");
          values.push(fees[i]!, tokens[i + 1]!);
        }
        const path = solidityPacked(types, values);
        const quote = await quoter.getFunction("quoteExactInput").staticCall(
          path, BigInt(input.amountIn), { blockTag: blockNumber }
        ) as readonly [bigint, readonly bigint[], readonly number[], bigint];
        return { fees, amountOut: quote[0].toString(), gasEstimate: quote[3].toString(), available: true as const };
      } catch (error) {
        return {
          fees, amountOut: null, gasEstimate: null, available: false as const,
          error: error instanceof Error ? error.message.slice(0, 180) : "Pool path unavailable"
        };
      }
    }));
    const available = candidates.filter((candidate) => candidate.available && candidate.amountOut !== null);
    const best = available.reduce<typeof available[number] | null>((current, candidate) =>
      current === null || BigInt(candidate.amountOut!) > BigInt(current.amountOut!) ? candidate : current, null);
    return {
      chainId: 1,
      blockNumber,
      tokens,
      amountIn: input.amountIn,
      selectedFees: best?.fees ?? null,
      amountOut: best?.amountOut ?? null,
      gasEstimate: best?.gasEstimate ?? null,
      candidatesChecked: candidates.length,
      candidates,
      source: "uniswap-v3-quoter-v2-multi-hop",
      executionEnabled: false,
      warning: "Search is limited to the supplied token sequence and standard fee tiers. Quoter success is a liquidity/price-impact screen, not a guarantee that a liquidation transaction will execute. It excludes Aave settlement constraints, flash-loan availability and fees, gas-price conversion, builder/MEV costs, and state changes between quote and execution. Simulate the complete transaction on a fork before any use."
    };
  } finally {
    await provider.destroy();
  }
}
