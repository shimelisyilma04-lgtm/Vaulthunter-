import { Contract, JsonRpcProvider, getAddress, solidityPacked } from "ethers";
import { UNISWAP_V3_QUOTER_V2_ABI } from "../chain/uniswap-v3-quote.js";

const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FACTORY_ABI = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"] as const;
const POOL_ABI = ["function liquidity() view returns (uint128)"] as const;
const QUOTER_ABI = UNISWAP_V3_QUOTER_V2_ABI;

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
  input: Omit<UniswapV3QuoteInput, "fee">,
  validationBlock?: number
): Promise<{
  chainId: 1;
  blockNumber: number;
  blockHash: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  selectedFee: number | null;
  amountOut: string | null;
  gasEstimate: string | null;
  initializedTicksCrossed: number | null;
  candidates: Array<{
    fee: number;
    poolAddress: string | null;
    currentLiquidity: string | null;
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
    const blockNumber = validationBlock ?? await provider.getBlockNumber();
    const pinnedBlock = await provider.getBlock(blockNumber);
    if (!pinnedBlock?.hash) throw new Error("Unable to load pinned quote block hash");
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
    const factory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
    const fees = [100, 500, 3000, 10000] as const;
    const candidates = await Promise.all(fees.map(async (fee) => {
      let poolAddress: string | null = null;
      let currentLiquidity: string | null = null;
      try {
        poolAddress = getAddress(String(await factory.getFunction("getPool")(tokenIn, tokenOut, fee, { blockTag: blockNumber })));
        if (poolAddress === "0x0000000000000000000000000000000000000000") {
          return { fee, poolAddress: null, currentLiquidity: null, amountOut: null, gasEstimate: null,
            initializedTicksCrossed: null, available: false as const, error: "No Uniswap V3 pool exists for this token pair at this fee tier" };
        }
        const pool = new Contract(poolAddress, POOL_ABI, provider);
        currentLiquidity = BigInt(await pool.getFunction("liquidity")({ blockTag: blockNumber })).toString();
        if (currentLiquidity === "0") {
          return { fee, poolAddress, currentLiquidity, amountOut: null, gasEstimate: null,
            initializedTicksCrossed: null, available: false as const, error: "Pool exists but has zero active in-range liquidity at the pinned block" };
        }
        const quote = await quoter.getFunction("quoteExactInputSingle").staticCall({
          tokenIn, tokenOut, amountIn: BigInt(input.amountIn), fee, sqrtPriceLimitX96: 0
        }, { blockTag: blockNumber }) as readonly [bigint, bigint, number, bigint];
        if (quote[0] <= 0n) {
          return { fee, poolAddress, currentLiquidity, amountOut: "0", gasEstimate: quote[3].toString(),
            initializedTicksCrossed: Number(quote[2]), available: false as const,
            error: "Pool returned zero output for this input amount" };
        }
        return {
          fee, poolAddress, currentLiquidity,
          amountOut: quote[0].toString(),
          gasEstimate: quote[3].toString(),
          initializedTicksCrossed: Number(quote[2]),
          available: true as const
        };
      } catch (error) {
        return {
          fee, poolAddress, currentLiquidity,
          amountOut: null, gasEstimate: null, initializedTicksCrossed: null,
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
      blockHash: pinnedBlock.hash,
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


export function enumerateUniswapV3FeeTiers(hops: number): number[][] {
  if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
    throw new Error("hops must be an integer from 1 to 3");
  }
  const tiers = [100, 500, 3000, 10000] as const;
  let combinations: number[][] = [[]];
  for (let hop = 0; hop < hops; hop++) {
    const expanded: number[][] = [];
    for (const prefix of combinations) for (const fee of tiers) expanded.push([...prefix, fee]);
    combinations = expanded;
  }
  return combinations;
}

export async function quoteUniswapV3BestPath(
  rpcUrl: string,
  input: { tokens: string[]; amountIn: string },
  validationBlock?: number
): Promise<{
  chainId: 1;
  blockNumber: number;
  tokens: string[];
  amountIn: string;
  selectedFees: number[] | null;
  amountOut: string | null;
  gasEstimate: string | null;
  blockHash: string;
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
  if (!/^\d+$/.test(input.amountIn) || BigInt(input.amountIn) <= 0n) {
    throw new Error("amountIn must be a positive integer in the input token's smallest units");
  }
  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error("Uniswap V3 path quotes require Ethereum mainnet (chain ID 1)");
    const blockNumber = validationBlock ?? await provider.getBlockNumber();
    const pinnedBlock = await provider.getBlock(blockNumber);
    if (!pinnedBlock?.hash) throw new Error("Unable to load pinned multi-hop quote block hash");
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, provider);
    const factory = new Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
    const combinations = enumerateUniswapV3FeeTiers(tokens.length - 1);
    const candidates = await Promise.all(combinations.map(async (fees) => {
      try {
        // Discover every hop at the same pinned block before invoking QuoterV2.
        // This distinguishes missing/empty pools from genuine quote failures.
        const hopPools: Array<{ address: string; liquidity: string }> = [];
        for (let hop = 0; hop < fees.length; hop++) {
          const rawPool = String(await factory.getFunction("getPool")(
            tokens[hop]!, tokens[hop + 1]!, fees[hop]!, { blockTag: blockNumber }
          ));
          if (rawPool.toLowerCase() === "0x0000000000000000000000000000000000000000") {
            throw new Error(`No pool for hop ${hop + 1} at fee tier ${fees[hop]}`);
          }
          const poolAddress = getAddress(rawPool);
          const pool = new Contract(poolAddress, POOL_ABI, provider);
          const liquidity = BigInt(await pool.getFunction("liquidity")({ blockTag: blockNumber }));
          if (liquidity === 0n) throw new Error(`Pool at hop ${hop + 1} has zero active liquidity`);
          hopPools.push({ address: poolAddress, liquidity: liquidity.toString() });
        }
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
        if (quote[0] <= 0n) return { fees, amountOut: "0", gasEstimate: quote[3].toString(), available: false as const, error: "Route returned zero output for this input amount" };
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
      blockHash: pinnedBlock.hash,
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


const UNISWAP_ROUTE_BRIDGES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44Da98b954EedeAC495271d0F"  // DAI
] as const;

export async function quoteUniswapV3BestRoute(
  rpcUrl: string,
  input: { tokenIn: string; tokenOut: string; amountIn: string },
  validationBlock: number
): Promise<Record<string, unknown> & { blockNumber: number; blockHash: string; amountOut: string | null; gasEstimate: string | null }> {
  const direct = await quoteUniswapV3BestExactInput(rpcUrl, input, validationBlock);
  if (direct.amountOut !== null && BigInt(direct.amountOut) > 0n) {
    return { ...direct, routeType: "direct", routeTokens: [getAddress(input.tokenIn), getAddress(input.tokenOut)] };
  }
  const bridges = UNISWAP_ROUTE_BRIDGES.filter((address) =>
    address.toLowerCase() !== input.tokenIn.toLowerCase() && address.toLowerCase() !== input.tokenOut.toLowerCase()
  );
  const paths = await Promise.all(bridges.map(async (bridge) => {
    try {
      return await quoteUniswapV3BestPath(rpcUrl, {
        tokens: [input.tokenIn, bridge, input.tokenOut], amountIn: input.amountIn
      }, validationBlock);
    } catch (error) {
      return { blockNumber: validationBlock, blockHash: "", tokens: [input.tokenIn, bridge, input.tokenOut], amountOut: null, gasEstimate: null,
        selectedFees: null, candidatesChecked: 0, candidates: [], error: error instanceof Error ? error.message.slice(0, 180) : "Path quote failed" };
    }
  }));
  const valid = paths.filter((path) => path.amountOut !== null && BigInt(path.amountOut) > 0n && path.blockHash.length > 0);
  const best = valid.reduce<typeof valid[number] | null>((current, path) =>
    current === null || BigInt(path.amountOut!) > BigInt(current.amountOut!) ? path : current, null);
  if (best) {
    return {
      chainId: 1, blockNumber: best.blockNumber, blockHash: best.blockHash,
      tokenIn: getAddress(input.tokenIn), tokenOut: getAddress(input.tokenOut), amountIn: input.amountIn,
      selectedFee: null, selectedFees: best.selectedFees, amountOut: best.amountOut, gasEstimate: best.gasEstimate,
      initializedTicksCrossed: null, candidates: direct.candidates, pathCandidates: paths,
      routeType: "two-hop", routeTokens: best.tokens, source: "uniswap-v3-quoter-v2-multi-hop",
      executionEnabled: false,
      warning: "Best two-hop Uniswap V3 quote across WETH, USDC, USDT and DAI bridges. Quote only; not a full liquidation transaction simulation."
    };
  }
  return {
    ...direct, routeType: "no-route", routeTokens: null, pathCandidates: paths,
    amountOut: null, gasEstimate: null
  };
}
