import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { config } from "../config.js";
import { WAD } from "../domain/liquidation.js";
import { accrueMorphoBorrowDebt } from "./accrual.js";
import { MorphoStore, type MorphoMarket } from "./store.js";
import { accrueMorphoBorrowDebt } from "./accrual.js";

export const MORPHO_BLUE_ETHEREUM = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ORACLE_ABI = ["function price() view returns (uint256)"];
const IRM_ABI = [
  "function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns (uint256)"
];
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
      result.push({
        chainId: row.chain_id, marketId: row.market_id.toLowerCase(),
        loanToken: getAddress(row.loan_token), collateralToken: getAddress(row.collateral_token),
        oracleAddress: getAddress(row.oracle_address), irmAddress: getAddress(row.irm_address),
        lltvWad: row.lltv_wad, creationBlock: Number(row.creation_block_number)
      });
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
  indexerCaughtUp: boolean; marketsRefreshed: number;
  positionsChecked: number; readFailures: number;
  candidates: Array<{
    marketId: string; borrower: string; observedBlock: number;
    debtAssets: string; collateralAssets: string; oraclePrice: string;
    lltvWad: string; healthFactorWad: string;
    accruedInterestAssets: string; borrowRateWadPerSecond: string;
  }>;
  executionEnabled: false;
}

export async function runMorphoScanPass(rpcUrl: string, store: MorphoStore): Promise<MorphoScanResult> {
  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error(`Morpho Ethereum adapter requires chain ID 1; got ${network.chainId}`);
    const head = await provider.getBlockNumber();
    const safeHead = Math.max(0, head - config.MORPHO_CONFIRMATIONS);
    const markets = await listMorphoEthereumMarkets();
    if (markets.length === 0) throw new Error("Morpho API returned no Ethereum Blue markets");
    for (const market of markets) store.upsertMarket(market);

    const startBlock = Math.min(...markets.map((m) => m.creationBlock));
    let checkpoint = store.getGlobalCheckpoint(1);
    if (checkpoint) {
      const canonical = await provider.getBlock(checkpoint.lastBlock);
      if (!canonical?.hash || canonical.hash.toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
        store.resetGlobalCheckpoint(1);
        checkpoint = null;
      }
    }
    let nextBlock = checkpoint ? checkpoint.lastBlock + 1 : startBlock;
    let marketBatchesIndexed = 0, borrowersDiscovered = 0, readFailures = 0;
    while (nextBlock <= safeHead && marketBatchesIndexed < config.MORPHO_INDEXER_MAX_BATCHES_PER_PASS) {
      const toBlock = Math.min(safeHead, nextBlock + config.MORPHO_INDEXER_BATCH_BLOCKS - 1);
      let logs: Log[];
      try {
        logs = await provider.getLogs({
          address: MORPHO_BLUE_ETHEREUM, fromBlock: nextBlock, toBlock,
          topics: [positionTopics]
        });
      } catch {
        readFailures += 1;
        break;
      }
      const block = await provider.getBlock(toBlock);
      if (!block?.hash) throw new Error(`Cannot verify Morpho block ${toBlock}`);
      const entries = decodeBorrowerEvents(logs);
      store.saveGlobalBatch(1, entries, toBlock, block.hash);
      borrowersDiscovered += entries.length;
      marketBatchesIndexed += 1;
      nextBlock = toBlock + 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const latestCheckpoint = store.getGlobalCheckpoint(1);
    const indexedThroughBlock = latestCheckpoint?.lastBlock ?? startBlock - 1;
    const indexerCaughtUp = indexedThroughBlock >= safeHead;
    let marketsRefreshed = 0, positionsChecked = 0;
    const candidates: MorphoScanResult["candidates"] = [];

    if (indexerCaughtUp) {
      const offset = store.getSnapshotMarketOffset(1) % markets.length;
      const count = Math.min(config.MORPHO_MARKETS_TO_REFRESH_PER_PASS, markets.length);
      const selected = Array.from({ length: count }, (_, i) => markets[(offset + i) % markets.length]!);
      const morpho = new Contract(MORPHO_BLUE_ETHEREUM, MORPHO_ABI, provider);
      for (const market of selected) {
        const borrowers = store.listBorrowers(1, market.marketId, config.MORPHO_SNAPSHOT_BATCH_SIZE);
        if (borrowers.length === 0) continue;
        try {
          const [state, priceRaw, params, observedBlock] = await Promise.all([
            morpho.getFunction("market")(market.marketId, { blockTag: head }) as Promise<readonly [bigint,bigint,bigint,bigint,bigint,bigint]>,
            new Contract(market.oracleAddress, ORACLE_ABI, provider).getFunction("price")({ blockTag: head }) as Promise<bigint>,
            morpho.getFunction("idToMarketParams")(market.marketId, { blockTag: head }) as Promise<readonly [string,string,string,string,bigint]>,
            provider.getBlock(head)
          ]);
          if (!observedBlock) throw new Error("Unable to resolve pinned block timestamp");
          const price = BigInt(priceRaw);
          if (price === 0n) continue;
          const marketState = {
            totalSupplyAssets: state[0], totalSupplyShares: state[1],
            totalBorrowAssets: state[2], totalBorrowShares: state[3],
            lastUpdate: state[4], fee: state[5]
          };
          const elapsed = BigInt(observedBlock.timestamp) - BigInt(state[4]);
          if (elapsed < 0n) throw new Error("Market lastUpdate is later than pinned block timestamp");
          const rate = market.irmAddress.toLowerCase() === "0x0000000000000000000000000000000000000000"
            ? 0n
            : BigInt(await new Contract(market.irmAddress, IRM_ABI, provider).getFunction("borrowRateView")({
                loanToken: params[0], collateralToken: params[1], oracle: params[2], irm: params[3], lltv: params[4]
              }, marketState, { blockTag: head }));
          const totalBorrowShares = BigInt(state[3]);
          if (totalBorrowShares === 0n) continue;
          for (const borrower of borrowers) {
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
              const healthFactor = debtAssets === 0n ? (2n ** 255n) : collateralValue * BigInt(market.lltvWad) / debtAssets;
              store.saveSnapshot({
                chainId: 1, marketId: market.marketId, address: borrower.address, observedBlock: head,
                borrowShares: borrowShares.toString(), debtAssets: debtAssets.toString(),
                collateralAssets: collateralAssets.toString(), oraclePrice: price.toString(),
                lltvWad: market.lltvWad, healthFactorWad: healthFactor.toString()
              });
              positionsChecked += 1;
              if (debtAssets > 0n && healthFactor < WAD) candidates.push({
                marketId: market.marketId, borrower: borrower.address, observedBlock: head,
                debtAssets: debtAssets.toString(), collateralAssets: collateralAssets.toString(),
                oraclePrice: price.toString(), lltvWad: market.lltvWad, healthFactorWad: healthFactor.toString(),
                accruedInterestAssets: debt.accruedInterestAssets.toString(),
                borrowRateWadPerSecond: rate.toString()
              });
            } catch { readFailures += 1; }
          }
        } catch { readFailures += 1; }
        marketsRefreshed += 1;
      }
      store.saveSnapshotMarketOffset(1, (offset + count) % markets.length);
    }

    candidates.sort((a,b)=>BigInt(a.healthFactorWad)<BigInt(b.healthFactorWad)?-1:BigInt(a.healthFactorWad)>BigInt(b.healthFactorWad)?1:0);
    return {
      chainId: 1, latestBlock: head, marketsDiscovered: markets.length,
      indexedFromBlock: startBlock, indexedThroughBlock, marketBatchesIndexed,
      borrowersDiscovered, indexerCaughtUp, marketsRefreshed, positionsChecked,
      readFailures, candidates, executionEnabled: false
    };
  } finally { await provider.destroy(); }
}
