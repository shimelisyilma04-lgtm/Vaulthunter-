import pino from "pino";
import { config } from "../config.js";
import { MorphoStore } from "./store.js";
import { runMorphoScanPass } from "./scanner.js";

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  if (!config.ETHEREUM_RPC_URL) throw new Error("ETHEREUM_RPC_URL is required for Morpho Blue scanning");
  const store = new MorphoStore(config.VAULTHUNTER_DB_PATH);
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  logger.info({
    databasePath: config.VAULTHUNTER_DB_PATH,
    maxMarkets: config.MORPHO_MAX_MARKETS,
    batchBlocks: config.MORPHO_INDEXER_BATCH_BLOCKS,
    executionEnabled: false
  }, "Starting Morpho Blue Ethereum scanner in read-only mode");
  try {
    do {
      const result = await runMorphoScanPass(config.ETHEREUM_RPC_URL, store);
      logger.info({
        ...result,
        candidates: undefined
      }, "Morpho Blue scan pass completed");
      for (const candidate of result.candidates) {
        logger.warn({
          protocol: "morpho-blue",
          chainId: 1,
          ...candidate,
          executionEnabled: false
        }, "Potential Morpho liquidation candidate — screening only; revalidate onchain");
      }
      if (once || stopping) break;
      await new Promise((resolve) => setTimeout(resolve, config.MORPHO_POLL_INTERVAL_MS));
    } while (!stopping);
  } finally {
    store.close();
    logger.info("Morpho scanner stopped; no transactions were submitted");
  }
}

main().catch((error: unknown) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Morpho scanner failed");
  process.exitCode = 1;
});
