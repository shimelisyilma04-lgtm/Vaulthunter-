import pino from "pino";
import { inspectConfiguredNetworks } from "./multi-chain.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const results = await inspectConfiguredNetworks();
if (results.length === 0) {
  logger.warn("No network RPC endpoints configured. Set BASE_RPC_URL and ARBITRUM_RPC_URL.");
  process.exitCode = 1;
} else {
  for (const result of results) {
    logger.info(result, "Network RPC health");
    if (result.status !== "connected") process.exitCode = 1;
  }
}
