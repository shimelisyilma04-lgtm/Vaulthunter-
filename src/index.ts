import pino from "pino";
import { spawn, type ChildProcess } from "node:child_process";
import { config, morphoRpcConfigError, rpcConfigError } from "./config.js";
import { AaveStore } from "./aave/store-factory.js";
import { runAaveIndexerPass } from "./aave/indexer.js";
import { startHttpServer } from "./api/server.js";
import { inspectConfiguredNetworks } from "./chain/multi-chain.js";
import { createMorphoStore } from "./morpho/store-factory.js";
import { runMorphoScanPass } from "./morpho/scanner.js";

const logger = pino({ level: config.LOG_LEVEL });
const store = new AaveStore(config.VAULTHUNTER_DB_PATH, config.DATABASE_URL);
const morphoStore = config.DATABASE_URL || config.NODE_ENV !== "production" ? createMorphoStore() : undefined;
const server = startHttpServer(store, morphoStore);

// Base/Arbitrum/Scroll connectivity probe; read-only and never signs or broadcasts.
void inspectConfiguredNetworks().then((networks) => {
  if (networks.length === 0) {
    logger.warn("No Base/Arbitrum/Scroll RPC endpoints configured; multi-chain checks skipped");
    return;
  }
  for (const network of networks) {
    logger.info(network, "Multi-chain RPC health");
  }
}).catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Multi-chain RPC health check failed");
});

if (rpcConfigError) {
  logger.error({ message: rpcConfigError }, "Ethereum RPC configuration is invalid; API remains online without live scans");
}

let stopping = false;
let simulationWorker: ChildProcess | undefined;

async function runIndexerLoop(): Promise<void> {
  if (!config.AAVE_INDEXER_ENABLED) {
    logger.info("Historical indexing is disabled; live bounded scans remain available through the API");
    return;
  }

  if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
    logger.error("Historical indexing requires DATABASE_URL on hosted production services; local SQLite is ephemeral on Render Free");
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

async function runMorphoIndexerLoop(): Promise<void> {
  if (!config.MORPHO_INDEXER_ENABLED) {
    logger.info("Morpho Blue historical indexing is disabled; set MORPHO_INDEXER_ENABLED=true to enable it");
    return;
  }
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
    logger.error("Morpho indexing requires DATABASE_URL in production; refusing ephemeral SQLite storage");
    return;
  }
  const morphoRpcUrl = config.MORPHO_RPC_URL ?? config.ETHEREUM_RPC_URL;
  if (morphoRpcConfigError) {
    logger.error({ message: morphoRpcConfigError }, "Morpho RPC configuration is invalid; falling back to ETHEREUM_RPC_URL");
  }
  if (!morphoRpcUrl) {
    logger.warn("MORPHO_RPC_URL or ETHEREUM_RPC_URL is missing; Morpho indexing is paused");
    return;
  }
  if (!morphoStore) {
    logger.error("Morpho indexer has no configured durable store; indexing is paused");
    return;
  }
  logger.info({
    maxMarkets: config.MORPHO_MAX_MARKETS,
    batchBlocks: config.MORPHO_INDEXER_BATCH_BLOCKS,
    maxBatchesPerPass: config.MORPHO_INDEXER_MAX_BATCHES_PER_PASS,
    liveLookbackBlocks: config.MORPHO_LIVE_LOOKBACK_BLOCKS,
    marketsToRefreshPerPass: config.MORPHO_MARKETS_TO_REFRESH_PER_PASS,
    snapshotBatchSize: config.MORPHO_SNAPSHOT_BATCH_SIZE,
    pollIntervalMs: config.MORPHO_POLL_INTERVAL_MS,
    rpcSource: config.MORPHO_RPC_URL ? "MORPHO_RPC_URL" : "ETHEREUM_RPC_URL",
    executionEnabled: false
  }, "Starting Morpho Blue Ethereum indexer in read-only mode");
  try {
    while (!stopping) {
      try {
        const result = await runMorphoScanPass(morphoRpcUrl, morphoStore);
        logger.info({ ...result, candidates: undefined }, "Morpho Blue indexer pass completed");
        for (const candidate of result.candidates) {
          logger.warn({
            protocol: "morpho-blue", chainId: 1, ...candidate, executionEnabled: false
          }, "Potential Morpho liquidation candidate — full-position quote is diagnostic only");
        }
        if (result.indexerCaughtUp) {
          await new Promise((resolve) => setTimeout(resolve, config.MORPHO_POLL_INTERVAL_MS));
        }
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) },
          "Morpho indexer pass failed; retrying after delay");
        await new Promise((resolve) => setTimeout(resolve, config.MORPHO_POLL_INTERVAL_MS));
      }
    }
  } finally {
    logger.info("Morpho indexer stopped; no transactions were submitted");
  }
}


async function runMorphoSimulationWorkerLoop(): Promise<void> {
  const token = process.env.VAULTHUNTER_SIMULATION_API_TOKEN;
  const forkRpc = process.env.ETHEREUM_FORK_UPSTREAM_RPC_URL ?? process.env.ETHEREUM_FORK_RPC_URL;
  if (config.NODE_ENV !== "production" || !token || !forkRpc) {
    logger.info({
      enabled: false,
      missing: [
        ...(!token ? ["VAULTHUNTER_SIMULATION_API_TOKEN"] : []),
        ...(!forkRpc ? ["ETHEREUM_FORK_UPSTREAM_RPC_URL"] : [])
      ]
    }, "Morpho fork simulation worker is not configured; API and indexers remain available");
    return;
  }

  logger.info({ pollIntervalMs: 15000, simulationOnly: true }, "Starting in-process supervised Morpho fork worker");
  while (!stopping) {
    await new Promise<void>((resolve) => {
      const foundryBin = process.env.HOME ? `${process.env.HOME}/.foundry/bin` : "";
      const childPath = [foundryBin, process.env.PATH ?? ""].filter(Boolean).join(":");
      simulationWorker = spawn(process.execPath, ["dist/scripts/morpho-simulation-worker.js"], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, PATH: childPath }
      });
      simulationWorker.once("error", (error) => {
        logger.error({ error: error.message }, "Morpho simulation worker failed to start");
        resolve();
      });
      simulationWorker.once("close", (code, signal) => {
        logger.warn({ code, signal }, "Morpho simulation worker exited; supervisor will restart it");
        simulationWorker = undefined;
        resolve();
      });
    });
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down VaultHunter");
  simulationWorker?.kill("SIGTERM");
  server.close(() => {
    void Promise.allSettled(backgroundLoops).then(async () => {
      await Promise.allSettled([store.close(), ...(morphoStore ? [morphoStore.close()] : [])]);
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const backgroundLoops: Promise<void>[] = [runIndexerLoop(), runMorphoIndexerLoop(), runMorphoSimulationWorkerLoop()];
