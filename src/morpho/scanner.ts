import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { config } from "../config.js";
import { WAD } from "../domain/liquidation.js";
import { accrueMorphoBorrowDebt } from "./accrual.js";
import { quoteMorphoLiquidation } from "./liquidation-quote.js";
import type { MorphoMarket } from "./store.js";
import type { MorphoStorePort } from "./store-port.js";

export const MORPHO_BLUE_ETHEREUM = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ORACLE_ABI = ["function price() view returns (uint256)"];
const MORPHO_ABI = [
  "event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)",
  "event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)"
] as const;
const morphoInterface = new Interface(MORPHO_ABI);
const IRM_ABI = ["function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns (uint256)"];
const positionTopics = ["Borrow","Repay","SupplyCollateral","WithdrawCollateral","Liquidate"]
  .map((name) => morphoInterface.getEvent(name)!.topicHash);

interface ApiMarket {
  chain_id: number; market_id: string; loan_token: string; collateral_token: string;
  oracle_address: string; irm_address: string; lltv_wad: string; creation_block_number: string;
}
interface ApiPage<T> { data: T[]; cursor: string | null; }
interface BorrowerEvent { marketId: string; address: string; }

function mapApiMarket(row: ApiMarket): MorphoMarket {
  return {
    chainId: row.chain_id, marketId: row.market_id.toLowerCase(),
    loanToken: getAddress(row.loan_token), collateralToken: getAddress(row.collateral_token),
    oracleAddress: getAddress(row.oracle_address), irmAddress: getAddress(row.irm_address),
    lltvWad: row.lltv_wad, creationBlock: Number(row.creation_block_number)
  };
}

async function getMorphoEthereumMarket(marketId: string): Promise<MorphoMarket> {
  const response = await getJson<{ data: ApiMarket }>(
    `https://api.morpho.org/v0/blue/markets/1:${marketId}`
  );
  if (response.data.chain_id !== 1 || response.data.market_id.toLowerCase() !== marketId.toLowerCase()) {
    throw new Error(`Morpho API returned mismatched market metadata for ${marketId}`);
  }
  return mapApiMarket(response.data);
}

type OnchainMarketParams = readonly [string, string, string, string, bigint];

export function mapOnchainMorphoMarket(
  marketId: string,
  params: OnchainMarketParams,
  fallbackCreationBlock: number
): MorphoMarket {
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    throw new Error("Invalid Morpho market ID");
  }
  return {
    chainId: 1,
    marketId: marketId.toLowerCase(),
    loanToken: getAddress(params[0]),
    collateralToken: getAddress(params[1]),
    oracleAddress: getAddress(params[2]),
    irmAddress: getAddress(params[3]),
    lltvWad: BigInt(params[4]).toString(),
    // The global historical scan starts at the Morpho Blue deployment-era
    // lower bound. This is a safe lower bound for legacy markets absent from
    // the public market list; it does not advance or rewind the checkpoint.
    creationBlock: fallbackCreationBlock
  };
}

async function getMorphoEthereumMarketFromChain(
  provider: JsonRpcProvider,
  marketId: string,
  fallbackCreationBlock: number
): Promise<MorphoMarket> {
  const morpho = new Contract(MORPHO_BLUE_ETHEREUM, MORPHO_ABI, provider);
  const params = await morpho.getFunction("idToMarketParams")(marketId) as OnchainMarketParams;
  return mapOnchainMorphoMarket(marketId, params, fallbackCreationBlock);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Morpho API returned ${response.status}`);
  return await response.json() as T;
}

export async function listMorphoEthereumMarkets(): Promise<MorphoMarket[]> {
  const result: MorphoMarket[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL("https://api.morpho.org/v0/blue/markets");
    url.searchParams.set("chain_id", "1");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await getJson<ApiPage<ApiMarket>>(url.toString());
    for (const row of page.data) {
      result.push(mapApiMarket(row));
      if (result.length >= config.MORPHO_MAX_MARKETS) return result;
    }
    cursor = page.cursor;
  } while (cursor);
  return result;
}

function decodeBorrowerEvents(logs: Log[]): BorrowerEvent[] {
  const entries = new Map<string, BorrowerEvent>();
  for (const log of logs) {
    try {
      const parsed = morphoInterface.parseLog(log);
      const marketId = log.topics[1]?.toLowerCase();
      const borrower = parsed?.name === "Liquidate"
        ? parsed.args.borrower as string
        : parsed?.args.onBehalf as string | undefined;
      if (marketId && borrower) {
        const address = getAddress(borrower);
        entries.set(`${marketId}:${address.toLowerCase()}`, { marketId, address });
      }
    } catch { /* Ignore unknown event records. */ }
  }
  return [...entries.values()];
}

export interface MorphoScanResult {
  chainId: 1; latestBlock: number; marketsDiscovered: number;
  indexedFromBlock: number; indexedThroughBlock: number;
  marketBatchesIndexed: number; borrowersDiscovered: number;
  liveWindowFromBlock: number; liveBorrowersDiscovered: number; liveDiscoverySucceeded: boolean;
  liveDiscoveryError?: string;
  indexerCaughtUp: boolean; marketsRefreshed: number;
  positionsChecked: number; readFailures: number;
  candidates: Array<{
    marketId: string; borrower: string; observedBlock: number;
    debtAssets: string; collateralAssets: string; oraclePrice: string;
    lltvWad: string; healthFactorWad: string;
    accruedInterestAssets: string; borrowRateWadPerSecond: string;
    liquidationQuote?: {
      repaidAssets: string; seizedAssets: string; liquidationIncentiveFactorWad: string;
      availableLoanLiquidity: string; liquiditySufficient: boolean; collateralSufficient: boolean; loanFundingVerified: false;
    };
  }>;
  executionEnabled: false;
}

export async function runMorphoScanPass(rpcUrl: string, store: MorphoStorePort): Promise<MorphoScanResult> {
  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error(`Morpho Ethereum adapter requires chain ID 1; got ${network.chainId}`);
    const head = await provider.getBlockNumber();
    const safeHead = Math.max(0, head - config.MORPHO_CONFIRMATIONS);
    const markets = await listMorphoEthereumMarkets();
    if (markets.length === 0) throw new Error("Morpho API returned no Ethereum Blue markets");
    const marketsById = new Map(markets.map((market) => [market.marketId, market]));
    for (const market of markets) await store.upsertMarket(market);

    const startBlock = Math.min(...markets.map((m) => m.creationBlock));
    let checkpoint = await store.getGlobalCheckpoint(1);
    if (checkpoint) {
      const canonical = await provider.getBlock(checkpoint.lastBlock);
      if (!canonical?.hash || canonical.hash.toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
        await store.resetGlobalCheckpoint(1);
        checkpoint = null;
      }
    }
    let nextBlock = checkpoint ? checkpoint.lastBlock + 1 : startBlock;
    let marketBatchesIndexed = 0, borrowersDiscovered = 0, readFailures = 0;
    let batchBlocks = config.MORPHO_INDEXER_BATCH_BLOCKS;
    let rateLimitRetries = 0;
    const discoveredMarketIds = new Set<string>();
    while (nextBlock <= safeHead && marketBatchesIndexed < config.MORPHO_INDEXER_MAX_BATCHES_PER_PASS) {
      const toBlock = Math.min(safeHead, nextBlock + batchBlocks - 1);
      let logs: Log[];
      try {
        logs = await provider.getLogs({
          address: MORPHO_BLUE_ETHEREUM, fromBlock: nextBlock, toBlock,
          topics: [positionTopics]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/429|rate.?limit|too many requests/i.test(message) && rateLimitRetries < 5) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** rateLimitRetries)));
          rateLimitRetries += 1;
          continue;
        }
        if (batchBlocks > 10) {
          batchBlocks = Math.max(10, Math.floor(batchBlocks / 2));
          rateLimitRetries = 0;
          continue;
        }
        readFailures += 1;
        break;
      }
      rateLimitRetries = 0;
      const block = await provider.getBlock(toBlock);
      if (!block?.hash) throw new Error(`Cannot verify Morpho block ${toBlock}`);
      const entries = decodeBorrowerEvents(logs);
      for (const entry of entries) discoveredMarketIds.add(entry.marketId);
      await store.saveGlobalBatch(1, entries, toBlock, block.hash);
      borrowersDiscovered += entries.length;
      marketBatchesIndexed += 1;
      nextBlock = toBlock + 1;
      // Ankr Ethereum Freemium allows about 30 Node API requests/second.
      // The history loop makes two RPC calls per batch; 250ms keeps it near
      // 8 requests/second, leaving headroom for market and borrower snapshots.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    let liveLookbackBlocks = config.MORPHO_LIVE_LOOKBACK_BLOCKS;
    let liveWindowFromBlock = Math.max(0, safeHead - liveLookbackBlocks + 1);
    let liveBorrowersDiscovered = 0;
    let liveDiscoverySucceeded = false;
    let liveDiscoveryError: string | undefined;
    for (let attempt = 0; attempt < 3 && !liveDiscoverySucceeded; attempt += 1) {
      liveWindowFromBlock = Math.max(0, safeHead - liveLookbackBlocks + 1);
      let recentEntries: Array<{ marketId: string; address: string }>;
      try {
        const recentLogs = await provider.getLogs({
          address: MORPHO_BLUE_ETHEREUM,
          fromBlock: liveWindowFromBlock,
          toBlock: safeHead,
          topics: [positionTopics]
        });
        recentEntries = decodeBorrowerEvents(recentLogs);
      } catch (error) {
        liveDiscoveryError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) {
          if (!/429|rate.?limit|too many requests/i.test(liveDiscoveryError)) {
            liveLookbackBlocks = Math.max(100, Math.floor(liveLookbackBlocks / 2));
          }
          await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        }
        continue;
      }
      try {
        await store.saveDiscoveredBorrowers(1, recentEntries);
        liveBorrowersDiscovered = recentEntries.length;
        for (const entry of recentEntries) discoveredMarketIds.add(entry.marketId);
        liveDiscoverySucceeded = true;
        liveDiscoveryError = undefined;
      } catch (error) {
        liveDiscoveryError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (!liveDiscoverySucceeded) readFailures += 1;

    const latestCheckpoint = await store.getGlobalCheckpoint(1);
    const indexedThroughBlock = latestCheckpoint?.lastBlock ?? startBlock - 1;
    const indexerCaughtUp = indexedThroughBlock >= safeHead;
    let marketsRefreshed = 0, positionsChecked = 0;
    const candidates: MorphoScanResult["candidates"] = [];

    {
      // Event history spans every Morpho Blue market, not just the API's first 1,000.
      // Rehydrate markets for all previously discovered borrowers, including after restarts.
      const borrowerMarketIds = new Set([
        ...discoveredMarketIds,
        ...(await store.listBorrowerMarketIds(1))
      ]);
      for (const marketId of borrowerMarketIds) {
        if (marketsById.has(marketId)) continue;
        try {
          // The public Morpho market-detail endpoint is enterprise-only.
          // Recover historical markets omitted from the first public list page
          // directly from Morpho's immutable on-chain market parameters.
          const market = await getMorphoEthereumMarketFromChain(provider, marketId, startBlock);
          marketsById.set(marketId, market);
          await store.upsertMarket(market);
        } catch { readFailures += 1; }
      }
      // Rotate through every borrower market so a large discovery set cannot
      // permanently starve markets after the first page of IDs. Within each
      // market, refresh never-seen/stale rows first, then stale high-risk debt
      // positions, then the oldest remaining snapshots.
      const refreshMarkets = [...marketsById.values()];
      const borrowerMarkets = [...borrowerMarketIds]
        .map((marketId) => marketsById.get(marketId))
        .filter((market): market is MorphoMarket => Boolean(market))
        .sort((a, b) => a.marketId.localeCompare(b.marketId));
      const offset = (await store.getSnapshotMarketOffset(1)) % refreshMarkets.length;
      const count = Math.min(config.MORPHO_MARKETS_TO_REFRESH_PER_PASS, refreshMarkets.length);
      const selectedById = new Map<string, MorphoMarket>();
      if (borrowerMarkets.length > 0) {
        const borrowerOffset = offset % borrowerMarkets.length;
        for (let i = 0; i < Math.min(count, borrowerMarkets.length); i += 1) {
          const market = borrowerMarkets[(borrowerOffset + i) % borrowerMarkets.length]!;
          selectedById.set(market.marketId, market);
        }
      }
      for (let i = 0; i < refreshMarkets.length && selectedById.size < count; i += 1) {
        const market = refreshMarkets[(offset + i) % refreshMarkets.length]!;
        selectedById.set(market.marketId, market);
      }
      const selected = [...selectedById.values()];
      const morpho = new Contract(MORPHO_BLUE_ETHEREUM, MORPHO_ABI, provider);
      for (const market of selected) {
        const borrowers = await store.listBorrowers(1, market.marketId, config.MORPHO_SNAPSHOT_BATCH_SIZE);
        if (borrowers.length === 0) continue;
        try {
          const [state, params, observedBlock] = await Promise.all([
            morpho.getFunction("market")(market.marketId, { blockTag: head }) as Promise<readonly [bigint,bigint,bigint,bigint,bigint,bigint]>,
            morpho.getFunction("idToMarketParams")(market.marketId, { blockTag: head }) as Promise<readonly [string,string,string,string,bigint]>,
            provider.getBlock(head)
          ]);
          if (!observedBlock) throw new Error("Unable to resolve pinned block timestamp");
          const oracleAddress = getAddress(params[2]);
          const irmAddress = getAddress(params[3]);
          const lltvWad = BigInt(params[4]).toString();
          if (oracleAddress.toLowerCase() !== market.oracleAddress.toLowerCase() ||
              irmAddress.toLowerCase() !== market.irmAddress.toLowerCase() ||
              lltvWad !== BigInt(market.lltvWad).toString()) {
            throw new Error("Morpho API market configuration does not match onchain immutable parameters");
          }
          const price = BigInt(await new Contract(oracleAddress, ORACLE_ABI, provider).getFunction("price")({ blockTag: head }));
          if (price === 0n) continue;
          const loanTokenAddress = getAddress(params[0]);
          const collateralTokenAddress = getAddress(params[1]);
          if (loanTokenAddress.toLowerCase() !== market.loanToken.toLowerCase() ||
              collateralTokenAddress.toLowerCase() !== market.collateralToken.toLowerCase()) {
            throw new Error("Morpho API token addresses do not match onchain immutable parameters");
          }
          // Morpho's own ERC-20 balance is shared across markets and is NOT the
          // liquidator's funding. Keep the quote explicitly unfunded until an
          // independent wallet/flash-loan source is supplied and verified.
          const availableLoanLiquidity = 0n;
          const marketState = {
            totalSupplyAssets: state[0], totalSupplyShares: state[1],
            totalBorrowAssets: state[2], totalBorrowShares: state[3],
            lastUpdate: state[4], fee: state[5]
          };
          const elapsed = BigInt(observedBlock.timestamp) - BigInt(state[4]);
          if (elapsed < 0n) throw new Error("Market lastUpdate is later than pinned block timestamp");
          const totalBorrowShares = BigInt(state[3]);
          const rate = totalBorrowShares === 0n || irmAddress.toLowerCase() === "0x0000000000000000000000000000000000000000"
            ? 0n
            : BigInt(await new Contract(irmAddress, IRM_ABI, provider).getFunction("borrowRateView")({
                loanToken: params[0], collateralToken: params[1], oracle: params[2], irm: params[3], lltv: params[4]
              }, marketState, { blockTag: head }));
          // Position reads are independent once market state and oracle data are pinned.
          // Four concurrent reads improve snapshot throughput while leaving headroom
          // under Ankr's shared request-rate limit for history and market calls.
          const borrowerReadConcurrency = 4;
          for (let borrowerOffset = 0; borrowerOffset < borrowers.length; borrowerOffset += borrowerReadConcurrency) {
            const borrowerBatch = borrowers.slice(borrowerOffset, borrowerOffset + borrowerReadConcurrency);
            await Promise.all(borrowerBatch.map(async (borrower) => {
              try {
                const position = await morpho.getFunction("position")(market.marketId, borrower.address, { blockTag: head }) as readonly [bigint,bigint,bigint];
                const borrowShares = BigInt(position[1]), collateralAssets = BigInt(position[2]);
                const debt = accrueMorphoBorrowDebt({
                  totalBorrowAssets: BigInt(state[2]), totalBorrowShares,
                  borrowShares, borrowRateWadPerSecond: rate,
                  elapsedSeconds: BigInt(observedBlock.timestamp) - BigInt(state[4])
                });
                const debtAssets = debt.borrowerDebtAssetsUp;
                const collateralValue = collateralAssets * price / (10n ** 36n);
                const healthFactor = debtAssets === 0n ? (2n ** 255n) : collateralValue * BigInt(lltvWad) / debtAssets;
                await store.saveSnapshot({
                  chainId: 1, marketId: market.marketId, address: borrower.address, observedBlock: head,
                  borrowShares: borrowShares.toString(), debtAssets: debtAssets.toString(),
                  collateralAssets: collateralAssets.toString(), oraclePrice: price.toString(),
                  lltvWad, healthFactorWad: healthFactor.toString()
                });
                positionsChecked += 1;
                if (debtAssets > 0n && healthFactor < WAD) {
                  let liquidationQuote: MorphoScanResult["candidates"][number]["liquidationQuote"];
                  try {
                    const quote = quoteMorphoLiquidation({
                      totalBorrowAssets: debt.accruedTotalBorrowAssets,
                      totalBorrowShares,
                      borrowerBorrowShares: borrowShares,
                      borrowerCollateralAssets: collateralAssets,
                      oraclePrice: price,
                      lltvWad: BigInt(lltvWad),
                      // Full-position diagnostic quote. It is not an execution instruction.
                      repaidShares: borrowShares,
                      availableLoanLiquidity
                    });
                    liquidationQuote = {
                      repaidAssets: quote.repaidAssets.toString(),
                      seizedAssets: quote.seizedAssets.toString(),
                      liquidationIncentiveFactorWad: quote.liquidationIncentiveFactorWad.toString(),
                      availableLoanLiquidity: availableLoanLiquidity.toString(),
                      liquiditySufficient: quote.liquiditySufficient,
                      collateralSufficient: quote.collateralSufficient,
                      loanFundingVerified: false
                    };
                  } catch {
                    readFailures += 1;
                  }
                  candidates.push({
                    marketId: market.marketId, borrower: borrower.address, observedBlock: head,
                    debtAssets: debtAssets.toString(), collateralAssets: collateralAssets.toString(),
                    oraclePrice: price.toString(), lltvWad, healthFactorWad: healthFactor.toString(),
                    accruedInterestAssets: debt.accruedInterestAssets.toString(),
                    borrowRateWadPerSecond: rate.toString(),
                    ...(liquidationQuote ? { liquidationQuote } : {})
                  });
                }
              } catch { readFailures += 1; }
            }));
          }
        } catch { readFailures += 1; }
        marketsRefreshed += 1;
      }
      await store.saveSnapshotMarketOffset(1, (offset + count) % refreshMarkets.length);
    }

    candidates.sort((a,b)=>BigInt(a.healthFactorWad)<BigInt(b.healthFactorWad)?-1:BigInt(a.healthFactorWad)>BigInt(b.healthFactorWad)?1:0);
    return {
      chainId: 1, latestBlock: head, marketsDiscovered: marketsById.size,
      indexedFromBlock: startBlock, indexedThroughBlock, marketBatchesIndexed,
      borrowersDiscovered, liveWindowFromBlock, liveBorrowersDiscovered, liveDiscoverySucceeded,
      ...(liveDiscoveryError ? { liveDiscoveryError } : {}),
      indexerCaughtUp, marketsRefreshed, positionsChecked,
      readFailures, candidates, executionEnabled: false
    };
  } finally { await provider.destroy(); }
}
