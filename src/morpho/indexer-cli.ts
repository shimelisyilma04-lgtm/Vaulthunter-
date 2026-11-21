import pino from "pino";
import { config } from "../config.js";
import { createMorphoStore } from "./store-factory.js";
import { runMorphoScanPass } from "./scanner.js";

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  if (!config.ETHEREUM_RPC_URL) throw new Error("ETHEREUM_RPC_URL is required for Morpho Blue indexing");
  const store = createMorphoStore();
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const result = await runMorphoScanPass(config.ETHEREUM_RPC_URL, store);
      logger.info({ ...result, candidates: undefined }, "Morpho Blue indexing pass completed");
      for (const candidate of result.candidates) {
        logger.warn({ ...candidate, protocol: "morpho-blue", chainId: 1, executionEnabled: false },
          "Potential Morpho liquidation candidate — diagnostic quote only; simulation and execution not authorized");
      }
      if (once || stopping) break;
      if (result.indexerCaughtUp) {
        await new Promise((resolve) => setTimeout(resolve, config.MORPHO_POLL_INTERVAL_MS));
      }
    } while (!stopping);
  } finally {
    await store.close();
    logger.info("Morpho indexer stopped; no transactions were submitted");
  }
}

main().catch((error: unknown) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Morpho indexer failed");
  process.exitCode = 1;
});
