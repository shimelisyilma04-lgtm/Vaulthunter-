import pino from "pino";
import { config, rpcConfigError } from "./config.js";
import { AaveStore } from "./aave/store.js";
import { runAaveIndexerPass } from "./aave/indexer.js";
import { startHttpServer } from "./api/server.js";

const logger = pino({ level: config.LOG_LEVEL });
const store = new AaveStore(config.VAULTHUNTER_DB_PATH);
const server = startHttpServer(store);

if (rpcConfigError) {
  logger.error({ message: rpcConfigError }, "Ethereum RPC configuration is invalid; API remains online without live scans");
}

let stopping = false;

async function runIndexerLoop(): Promise<void> {
  if (!config.AAVE_INDEXER_ENABLED) {
    logger.info("Historical indexing is disabled; live bounded scans remain available through the API");
    return;
  }

  if (!config.ETHEREUM_RPC_URL) {
    logger.warn("ETHEREUM_RPC_URL is not configured; API is online but indexing is paused");
    return;
  }

  logger.info({
    databasePath: config.VAULTHUNTER_DB_PATH,
    startBlock: config.AAVE_INDEXER_START_BLOCK ?? null,
    confirmations: config.AAVE_INDEXER_CONFIRMATIONS,
    batchBlocks: config.AAVE_INDEXER_BATCH_BLOCKS,
    executionEnabled: false
  }, "Starting Aave V3 indexer in read-only mode");

  while (!stopping) {
    try {
      const result = await runAaveIndexerPass(config.ETHEREUM_RPC_URL, store);
      logger.info(result, "Aave indexer pass completed");
      if (result.caughtUp) {
        await new Promise((resolve) => setTimeout(resolve, config.AAVE_INDEXER_POLL_INTERVAL_MS));
      }
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error)
      }, "Aave indexer pass failed; retrying after delay");
      await new Promise((resolve) => setTimeout(resolve, config.AAVE_INDEXER_POLL_INTERVAL_MS));
    }
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down VaultHunter");
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

void runIndexerLoop();
