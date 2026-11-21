import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  type Log
} from "ethers";
import { config } from "../config.js";
import { WAD } from "../domain/liquidation.js";
import {
  AAVE_POOL_ABI,
  AAVE_V3_ETHEREUM_ADDRESSES_PROVIDER,
  ADDRESSES_PROVIDER_ABI
} from "./abi.js";
import { AaveStore, type StoredBorrowEvent, type StoredLiquidationCandidate } from "./store.js";

const protocol = "aave-v3";
const chainId = 1;
const poolInterface = new Interface(AAVE_POOL_ABI);
const borrowTopic = poolInterface.getEvent("Borrow")!.topicHash;

export interface IndexerPassResult {
  poolAddress: string;
  fromBlock: number;
  toBlock: number;
  indexedEvents: number;
  knownBorrowers: number;
  snapshotsUpdated: number;
  accountReadFailures: number;
  candidates: StoredLiquidationCandidate[];
  reorgDetected: boolean;
  caughtUp: boolean;
  database: {
    eventCount: number;
    borrowerCount: number;
    candidateCount: number;
  };
}

async function getLogsWithRetry(
  provider: JsonRpcProvider,
  poolAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<Log[]> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await provider.getLogs({
        address: poolAddress,
        fromBlock,
        toBlock,
        topics: [borrowTopic]
      });
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  return [];
}

function decodeBorrowEvents(
  logs: Log[],
  poolAddress: string,
  timestampsByBlock: Map<number, number>
): StoredBorrowEvent[] {
  const events: StoredBorrowEvent[] = [];
  for (const log of logs) {
    try {
      const parsed = poolInterface.parseLog(log);
      const borrower = parsed?.args.onBehalfOf as string | undefined;
      const reserve = parsed?.args.reserve as string | undefined;
      const amount = parsed?.args.amount as bigint | undefined;
      if (!borrower || !reserve || amount === undefined) continue;
      events.push({
        chainId,
        poolAddress,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        borrower: getAddress(borrower),
        reserve: getAddress(reserve),
        amount: amount.toString(),
        blockTimestamp: timestampsByBlock.get(log.blockNumber) ?? 0
      });
    } catch {
      // Malformed or unknown events are ignored, not persisted as borrower activity.
    }
  }
  return events;
}

export async function runAaveIndexerPass(
  rpcUrl: string,
  store: AaveStore
): Promise<IndexerPassResult> {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  let reorgDetected = false;
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(chainId)) {
      throw new Error(`Aave indexer requires Ethereum chain ID 1; received ${network.chainId}`);
    }

    const providerContract = new Contract(
      AAVE_V3_ETHEREUM_ADDRESSES_PROVIDER,
      ADDRESSES_PROVIDER_ABI,
      provider
    );
    const poolAddress = getAddress(
      await providerContract.getFunction("getPool")() as string
    );

    const head = await provider.getBlockNumber();
    const safeHead = Math.max(0, head - config.AAVE_INDEXER_CONFIRMATIONS);
    const checkpoint = store.getCheckpoint(protocol, chainId, poolAddress);

    let nextBlock: number;
    if (!checkpoint) {
      if (config.AAVE_INDEXER_START_BLOCK === undefined) {
        throw new Error(
          "AAVE_INDEXER_START_BLOCK is required for the first historical backfill. " +
          "Set it to the Aave V3 Ethereum Pool deployment block."
        );
      }
      nextBlock = config.AAVE_INDEXER_START_BLOCK;
    } else {
      const canonical = await provider.getBlock(checkpoint.lastBlock);
      if (!canonical || canonical.hash?.toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
        reorgDetected = true;
        const rewindBlock = Math.max(
          config.AAVE_INDEXER_START_BLOCK ?? 0,
          checkpoint.lastBlock - config.AAVE_INDEXER_CONFIRMATIONS
        );
        const rewind = await provider.getBlock(rewindBlock);
        if (!rewind?.hash) throw new Error(`Unable to verify canonical rewind block ${rewindBlock}`);
        store.rollbackTo(protocol, chainId, poolAddress, rewindBlock, rewind.hash);
        nextBlock = rewindBlock + 1;
      } else {
        nextBlock = checkpoint.lastBlock + 1;
      }
    }

    let indexedEvents = 0;
    let lastCompleted = nextBlock - 1;
    for (
      let fromBlock = nextBlock;
      fromBlock <= safeHead;
      fromBlock += config.AAVE_INDEXER_BATCH_BLOCKS
    ) {
      const toBlock = Math.min(
        safeHead,
        fromBlock + config.AAVE_INDEXER_BATCH_BLOCKS - 1
      );
      const logs = await getLogsWithRetry(provider, poolAddress, fromBlock, toBlock);
      const endBlock = await provider.getBlock(toBlock);
      if (!endBlock?.hash) throw new Error(`Unable to retrieve block hash for ${toBlock}`);
      const timestampsByBlock = new Map<number, number>();
      for (const blockNumber of new Set(logs.map((log) => log.blockNumber))) {
        const eventBlock = await provider.getBlock(blockNumber);
        if (eventBlock) timestampsByBlock.set(blockNumber, eventBlock.timestamp);
      }
      const events = decodeBorrowEvents(logs, poolAddress, timestampsByBlock);
      store.saveEventsAndCheckpoint(
        protocol, chainId, poolAddress, events, toBlock, endBlock.hash
      );
      indexedEvents += events.length;
      lastCompleted = toBlock;
      // Pace sequential eth_getLogs requests on free RPC tiers.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // Avoid spending RPC quota refreshing account data for every tiny historical batch.
    // Snapshots are refreshed after the event index catches up to the confirmed chain head.
    const caughtUp = lastCompleted >= safeHead;
    const pool = new Contract(poolAddress, AAVE_POOL_ABI, provider);
    const borrowers = caughtUp
      ? store.listBorrowers(chainId, poolAddress, config.AAVE_INDEXER_SNAPSHOT_BATCH_SIZE)
      : [];
    let snapshotsUpdated = 0;
    let accountReadFailures = 0;

    for (let offset = 0; offset < borrowers.length; offset += 5) {
      const batch = borrowers.slice(offset, offset + 5);
      const results = await Promise.all(batch.map(async (borrower) => {
        try {
          const account = await pool.getFunction("getUserAccountData")(borrower.address) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
          const collateral = account[0];
          const debt = account[1];
          const healthFactor = account[5];
          store.saveSnapshot({
            chainId,
            poolAddress,
            address: borrower.address,
            observedBlock: head,
            totalCollateralBase: collateral.toString(),
            totalDebtBase: debt.toString(),
            healthFactorWad: healthFactor.toString(),
            liquidationEligible: debt > 0n && healthFactor > 0n && healthFactor < WAD
          });
          return true;
        } catch {
          accountReadFailures += 1;
          return false;
        }
      }));
      snapshotsUpdated += results.filter(Boolean).length;
    }

    const stats = store.getStats(chainId, poolAddress);
    return {
      poolAddress,
      fromBlock: nextBlock,
      toBlock: Math.max(lastCompleted, checkpoint?.lastBlock ?? 0),
      indexedEvents,
      knownBorrowers: borrowers.length,
      snapshotsUpdated,
      accountReadFailures,
      candidates: store.listCandidates(chainId, poolAddress, 100),
      reorgDetected,
      caughtUp,
      database: {
        eventCount: stats.eventCount,
        borrowerCount: stats.borrowerCount,
        candidateCount: stats.candidateCount
      }
    };
  } finally {
    await provider.destroy();
  }
}
