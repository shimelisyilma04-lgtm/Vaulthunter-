import pino from "pino";
import { config } from "./config.js";
import { getEthereumRpcSnapshot } from "./chain/rpc.js";

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  logger.info(
    {
      environment: config.NODE_ENV,
      rpcConfigured: Boolean(config.ETHEREUM_RPC_URL),
      executionEnabled: false
    },
    "VaultHunter started in read-only mode"
  );

  if (!config.ETHEREUM_RPC_URL) {
    logger.warn("No Ethereum RPC URL configured; protocol scanning is not active yet");
    return;
  }

  try {
    const snapshot = await getEthereumRpcSnapshot(config.ETHEREUM_RPC_URL);
    logger.info(
      {
        chainId: snapshot.chainId,
        latestBlock: snapshot.blockNumber.toString()
      },
      "Connected to Ethereum RPC successfully"
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Ethereum RPC connection failed"
    );
    process.exitCode = 1;
  }

  logger.info("Read-only mode is enforced. No transactions will be submitted.");
}

await main();
