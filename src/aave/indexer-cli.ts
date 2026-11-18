import pino from "pino";
import { config } from "../config.js";
import { AaveStore } from "./store-factory.js";
import { runAaveIndexerPass } from "./indexer.js";

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required to run the Aave historical indexer");
  }

  if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
    throw new Error("Set DATABASE_URL to durable PostgreSQL before running the hosted historical indexer.");
  }
  const store = new AaveStore(config.VAULTHUNTER_DB_PATH, config.DATABASE_URL);
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  logger.info({
    databasePath: config.VAULTHUNTER_DB_PATH,
    startBlock: config.AAVE_INDEXER_START_BLOCK ?? null,
    confirmations: config.AAVE_INDEXER_CONFIRMATIONS,
    batchBlocks: config.AAVE_INDEXER_BATCH_BLOCKS,
    executionEnabled: false
  }, "Starting Aave V3 historical indexer in read-only mode");

  try {
    do {
      const result = await runAaveIndexerPass(config.ETHEREUM_RPC_URL, store);
      logger.info(result, "Aave historical indexing pass completed");
      if (once || stopping) break;
      // While historical blocks remain, continue immediately instead of idling 30 seconds
      // after every 10-block batch. Poll at the configured interval only when caught up.
      if (result.caughtUp) {
        await new Promise((resolve) => setTimeout(resolve, config.AAVE_INDEXER_POLL_INTERVAL_MS));
      }
    } while (!stopping);
  } finally {
    await store.close();
    logger.info("Aave indexer stopped; no transactions were submitted");
  }
}

main().catch((error: unknown) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Aave indexer failed");
  process.exitCode = 1;
});
