import pino from "pino";
import { config } from "../config.js";
import { scanAaveBorrowers } from "./scanner.js";

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("ETHEREUM_RPC_URL is required to run the Aave scanner");
  }

  logger.info(
    { executionEnabled: false, lookbackBlocks: config.AAVE_SCAN_LOOKBACK_BLOCKS },
    "Starting bounded, read-only Aave V3 borrower scan"
  );

  const result = await scanAaveBorrowers(
    config.ETHEREUM_RPC_URL,
    config.AAVE_SCAN_LOOKBACK_BLOCKS
  );

  logger.info(
    {
      chainId: result.chainId,
      pool: result.pool,
      fromBlock: result.fromBlock,
      toBlock: result.toBlock,
      borrowersDiscovered: result.borrowersDiscovered,
      accountsChecked: result.accountsChecked,
      accountReadFailures: result.accountReadFailures,
      liquidationCandidates: result.candidates.length
    },
    "Aave V3 scan completed"
  );

  for (const candidate of result.candidates) {
    logger.warn(candidate, "Potentially liquidatable Aave account; revalidate before any action");
  }

  logger.info("Read-only scan complete. No transactions were submitted.");
}

main().catch((error: unknown) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Aave scan failed");
  process.exitCode = 1;
});
