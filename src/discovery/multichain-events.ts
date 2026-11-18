import { Contract, Interface, JsonRpcProvider, getAddress, id } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "../aave/l2-readonly.js";
import { MORPHO_BLUE_ADDRESSES, type MorphoNetwork } from "../morpho/blue.js";

const PROVIDER_ABI = ["function getPool() view returns (address)"] as const;
const AAVE_BORROW = new Interface([
  "event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)"
]);
const MORPHO_BORROW = id("Borrow(bytes32,address,address,address,uint256,uint256)");
const MORPHO_SUPPLY_COLLATERAL = id("SupplyCollateral(bytes32,address,address,uint256)");
const MORPHO_CREATE_MARKET = id("CreateMarket(bytes32,(address,address,address,address,uint256))");
const MAX_LOOKBACK = 100_000;
const MAX_CHUNK = 2_000;
const MAX_ADDRESSES = 2_000;
const MAX_MARKETS = 2_000;

export interface DiscoveryResult {
  network: "base" | "arbitrum";
  chainId: number;
  fromBlock: number;
  toBlock: number;
  blocksScanned: number;
  borrowers: string[];
  markets: string[];
  borrowEvents: number;
  collateralEvents: number;
  marketCreatedEvents: number;
  completeness: "bounded-recent-event-window";
  refreshedAt: string;
}

function boundedInteger(value: number, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/**
 * Bounded, read-only event discovery. It does not claim to enumerate every
 * historical account: callers should persist discoveries and keep scanning
 * overlapping windows. Every candidate must be refreshed against live state.
 */
export async function discoverMultichainCandidates(args: {
  network: AaveL2Network;
  rpcUrl: string;
  lookbackBlocks?: number;
}): Promise<DiscoveryResult> {
  const market = AAVE_V3_MARKETS[args.network];
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(market.chainId)) {
      throw new Error(`Expected chain ${market.chainId}; received ${chain.chainId}`);
    }
    const toBlock = await provider.getBlockNumber();
    const lookback = boundedInteger(args.lookbackBlocks ?? 10_000, 10_000, MAX_LOOKBACK);
    const fromBlock = Math.max(0, toBlock - lookback + 1);
    const addressesProvider = new Contract(market.addressesProvider, PROVIDER_ABI, provider);
    const poolAddress = getAddress(await addressesProvider.getFunction("getPool")() as string);
    const borrowers = new Set<string>();
    let borrowEvents = 0;

    for (let start = fromBlock; start <= toBlock; start += MAX_CHUNK) {
      const end = Math.min(toBlock, start + MAX_CHUNK - 1);
      const logs = await provider.getLogs({
        address: poolAddress,
        fromBlock: start,
        toBlock: end,
        topics: [AAVE_BORROW.getEvent("Borrow")!.topicHash]
      });
      for (const log of logs) {
        const parsed = AAVE_BORROW.parseLog(log);
        const address = parsed?.args.onBehalfOf as string | undefined;
        if (address) borrowers.add(getAddress(address));
        borrowEvents += 1;
        if (borrowers.size >= MAX_ADDRESSES) break;
      }
      if (borrowers.size >= MAX_ADDRESSES) break;
    }

    return {
      network: args.network,
      chainId: market.chainId,
      fromBlock,
      toBlock,
      blocksScanned: toBlock - fromBlock + 1,
      borrowers: [...borrowers],
      markets: [],
      borrowEvents,
      collateralEvents: 0,
      marketCreatedEvents: 0,
      completeness: "bounded-recent-event-window",
      refreshedAt: new Date().toISOString()
    };
  } finally {
    await provider.destroy();
  }
}

/** Discover Morpho Blue market IDs and position owners from recent protocol events. */
export async function discoverMorphoBlueCandidates(args: {
  network: MorphoNetwork;
  rpcUrl: string;
  lookbackBlocks?: number;
}): Promise<DiscoveryResult> {
  const chainId = args.network === "base" ? 8453 : 42161;
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(chainId)) {
      throw new Error(`Expected chain ${chainId}; received ${chain.chainId}`);
    }
    const toBlock = await provider.getBlockNumber();
    const lookback = boundedInteger(args.lookbackBlocks ?? 10_000, 10_000, MAX_LOOKBACK);
    const fromBlock = Math.max(0, toBlock - lookback + 1);
    const morpho = getAddress(MORPHO_BLUE_ADDRESSES[args.network]);
    const borrowers = new Set<string>();
    const markets = new Set<string>();
    let borrowEvents = 0;
    let collateralEvents = 0;
    let marketCreatedEvents = 0;

    for (let start = fromBlock; start <= toBlock; start += MAX_CHUNK) {
      const end = Math.min(toBlock, start + MAX_CHUNK - 1);
      const [borrows, collateral, created] = await Promise.all([
        provider.getLogs({ address: morpho, fromBlock: start, toBlock: end, topics: [MORPHO_BORROW] }),
        provider.getLogs({ address: morpho, fromBlock: start, toBlock: end, topics: [MORPHO_SUPPLY_COLLATERAL] }),
        provider.getLogs({ address: morpho, fromBlock: start, toBlock: end, topics: [MORPHO_CREATE_MARKET] })
      ]);
      for (const log of borrows) {
        const owner = log.topics[2];
        if (owner && owner.length === 66) borrowers.add(getAddress("0x" + owner.slice(26)));
        if (log.topics[1]) markets.add(log.topics[1]);
        borrowEvents += 1;
      }
      for (const log of collateral) {
        const owner = log.topics[2];
        if (owner && owner.length === 66) borrowers.add(getAddress("0x" + owner.slice(26)));
        if (log.topics[1]) markets.add(log.topics[1]);
        collateralEvents += 1;
      }
      for (const log of created) {
        if (log.topics[1]) markets.add(log.topics[1]);
        marketCreatedEvents += 1;
      }
      if (borrowers.size >= MAX_ADDRESSES || markets.size >= MAX_MARKETS) break;
    }

    return {
      network: args.network,
      chainId,
      fromBlock,
      toBlock,
      blocksScanned: toBlock - fromBlock + 1,
      borrowers: [...borrowers].slice(0, MAX_ADDRESSES),
      markets: [...markets].slice(0, MAX_MARKETS),
      borrowEvents,
      collateralEvents,
      marketCreatedEvents,
      completeness: "bounded-recent-event-window",
      refreshedAt: new Date().toISOString()
    };
  } finally {
    await provider.destroy();
  }
}
