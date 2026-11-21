import { Contract, Interface, JsonRpcProvider, getAddress, type Log } from "ethers";
import { config } from "../config.js";
import { WAD } from "../domain/liquidation.js";
import { MorphoStore, type MorphoMarket } from "./store.js";

export const MORPHO_BLUE_ETHEREUM = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ORACLE_ABI = ["function price() view returns (uint256)"];
const MORPHO_ABI = [
  "event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)",
  "event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)",
  "event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)",
  "event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)",
  "event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)"
] as const;
const morphoInterface = new Interface(MORPHO_ABI);
const positionTopics = ["Borrow","Repay","SupplyCollateral","WithdrawCollateral","Liquidate"]
  .map((name) => morphoInterface.getEvent(name)!.topicHash);

interface ApiMarket {
  chain_id: number; market_id: string; loan_token: string; collateral_token: string;
  oracle_address: string; irm_address: string; lltv_wad: string; creation_block_number: string;
}
interface ApiPage<T> { data: T[]; cursor: string | null; }

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

function decodeBorrowers(logs: Log[]): string[] {
  const addresses = new Set<string>();
  for (const log of logs) {
    try {
      const parsed = morphoInterface.parseLog(log);
      const borrower = parsed?.name === "Liquidate"
        ? parsed.args.borrower as string
        : parsed?.args.onBehalf as string | undefined;
      if (borrower) addresses.add(getAddress(borrower));
    } catch { /* Ignore unknown event records. */ }
  }
  return [...addresses];
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("Expected positive denominator");
  return (a + b - 1n) / b;
}

export interface MorphoScanResult {
  chainId: 1; latestBlock: number; marketsDiscovered: number;
  marketBatchesIndexed: number; borrowersDiscovered: number;
  positionsChecked: number; readFailures: number;
  candidates: Array<{
    marketId: string; borrower: string; observedBlock: number;
    debtAssets: string; collateralAssets: string; oraclePrice: string;
    lltvWad: string; healthFactorWad: string;
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
    const morpho = new Contract(MORPHO_BLUE_ETHEREUM, MORPHO_ABI, provider);
    let marketBatchesIndexed = 0, borrowersDiscovered = 0, positionsChecked = 0, readFailures = 0;
    const candidates: MorphoScanResult["candidates"] = [];

    for (const market of markets) {
      store.upsertMarket(market);
      let checkpoint = store.getCheckpoint(1, market.marketId);
      if (checkpoint) {
        const canonical = await provider.getBlock(checkpoint.lastBlock);
        if (!canonical?.hash || canonical.hash.toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
          store.resetMarketCheckpoint(1, market.marketId, market.creationBlock - 1, "0x");
          checkpoint = null;
        }
      }
      let next = checkpoint ? checkpoint.lastBlock + 1 : market.creationBlock;
      while (next <= safeHead) {
        const to = Math.min(safeHead, next + config.MORPHO_INDEXER_BATCH_BLOCKS - 1);
        let logs: Log[];
        try {
          logs = await provider.getLogs({
            address: MORPHO_BLUE_ETHEREUM, fromBlock: next, toBlock: to,
            topics: [positionTopics, market.marketId]
          });
        } catch {
          readFailures += 1;
          break;
        }
        const block = await provider.getBlock(to);
        if (!block?.hash) throw new Error(`Cannot verify Morpho block ${to}`);
        const borrowers = decodeBorrowers(logs);
        store.saveBatch(1, market.marketId, borrowers, to, block.hash);
        borrowersDiscovered += borrowers.length;
        marketBatchesIndexed += 1;
        next = to + 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const latest = store.getCheckpoint(1, market.marketId);
      if (!latest || latest.lastBlock < safeHead) continue;
      const borrowers = store.listBorrowers(1, market.marketId, config.MORPHO_SNAPSHOT_BATCH_SIZE);
      if (!borrowers.length) continue;
      try {
        const [state, priceRaw] = await Promise.all([
          morpho.getFunction("market")(market.marketId, { blockTag: head }) as Promise<readonly [bigint,bigint,bigint,bigint,bigint,bigint]>,
          new Contract(market.oracleAddress, ORACLE_ABI, provider).getFunction("price")({ blockTag: head }) as Promise<bigint>
        ]);
        const totalBorrowAssets = BigInt(state[2]), totalBorrowShares = BigInt(state[3]), price = BigInt(priceRaw);
        if (totalBorrowShares === 0n || price === 0n) continue;
        for (const borrower of borrowers) {
          try {
            const position = await morpho.getFunction("position")(market.marketId, borrower.address, { blockTag: head }) as readonly [bigint,bigint,bigint];
            const borrowShares = BigInt(position[1]), collateralAssets = BigInt(position[2]);
            const debtAssets = borrowShares === 0n ? 0n : ceilDiv(borrowShares * totalBorrowAssets, totalBorrowShares);
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
              oraclePrice: price.toString(), lltvWad: market.lltvWad, healthFactorWad: healthFactor.toString()
            });
          } catch { readFailures += 1; }
        }
      } catch { readFailures += 1; }
    }
    candidates.sort((a,b)=>BigInt(a.healthFactorWad)<BigInt(b.healthFactorWad)?-1:BigInt(a.healthFactorWad)>BigInt(b.healthFactorWad)?1:0);
    return { chainId:1, latestBlock:head, marketsDiscovered:markets.length,
      marketBatchesIndexed, borrowersDiscovered, positionsChecked, readFailures,
      candidates, executionEnabled:false };
  } finally { await provider.destroy(); }
}
