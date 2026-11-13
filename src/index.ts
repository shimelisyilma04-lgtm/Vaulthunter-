import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.LOG_LEVEL });

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
}

logger.info("Milestone 1 foundation loaded. No transactions will be submitted.");
