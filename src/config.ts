import "dotenv/config";
import { z } from "zod";

// Trim accidental whitespace/quotes from dashboard-entered secrets. A malformed
// RPC value must not prevent the read-only dashboard/API from starting.
const rawRpcUrl = process.env.ETHEREUM_RPC_URL?.trim().replace(/^["']|["']$/g, "");
const rpcUrlResult = rawRpcUrl ? z.string().url().safeParse(rawRpcUrl) : null;
const rawMorphoRpcUrl = process.env.MORPHO_RPC_URL?.trim().replace(/^["']|["']$/g, "");
const morphoRpcUrlResult = rawMorphoRpcUrl ? z.string().url().safeParse(rawMorphoRpcUrl) : null;
export const rpcConfigError = rawRpcUrl && !rpcUrlResult?.success
  ? "ETHEREUM_RPC_URL is not a valid absolute URL. Use the provider's full HTTPS endpoint."
  : null;
export const morphoRpcConfigError = rawMorphoRpcUrl && !morphoRpcUrlResult?.success
  ? "MORPHO_RPC_URL is not a valid absolute URL. Use an archive-capable Ethereum HTTPS endpoint."
  : null;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  MORPHO_RPC_URL: z.string().url().optional(),
  ETHEREUM_FORK_RPC_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  VAULTHUNTER_SIMULATION_API_TOKEN: z.preprocess((value) => typeof value === "string" && value.trim() === "" ? undefined : value, z.string().min(32).optional()),
  DATABASE_URL: z.string().url().optional(),
  AAVE_SUBGRAPH_API_KEY: z.preprocess(
    (value) => typeof value === "string"
      ? value.trim().replace(/^["']|["']$/g, "") || undefined
      : value,
    z.string().min(1).optional()
  ),
  AAVE_SUBGRAPH_SYNC_INTERVAL_MS: z.coerce.number().int().min(60000).max(86400000).default(900000),
  MORPHO_INDEXER_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  MORPHO_MAX_MARKETS: z.coerce.number().int().min(1).max(1000).default(1000),
  MORPHO_INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(10000).default(1000),
  MORPHO_INDEXER_MAX_BATCHES_PER_PASS: z.coerce.number().int().min(1).max(5000).default(100),
  MORPHO_LIVE_LOOKBACK_BLOCKS: z.coerce.number().int().min(100).max(3000).default(2500),
  MORPHO_CONFIRMATIONS: z.coerce.number().int().min(1).max(256).default(12),
  MORPHO_SNAPSHOT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MORPHO_MARKETS_TO_REFRESH_PER_PASS: z.coerce.number().int().min(1).max(1000).default(25),
  MORPHO_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(3600000).default(30000),
  AAVE_SCAN_LOOKBACK_BLOCKS: z.coerce.number().int().min(1).max(10000).default(100),
  AAVE_INDEXER_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AAVE_INDEXER_START_BLOCK: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : Number(value),
    z.number().int().min(0).optional()
  ),
  AAVE_INDEXER_CONFIRMATIONS: z.coerce.number().int().min(1).max(256).default(12),
  AAVE_INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(10).default(10),
  AAVE_INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(3600000).default(30000),
  AAVE_INDEXER_SNAPSHOT_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  VAULTHUNTER_DB_PATH: z.string().min(1).default("./data/vaulthunter.sqlite"),
  VAULTHUNTER_EXECUTION_ENABLED: z.literal("false").default("false")
});

const parsed = envSchema.safeParse({
  ...process.env,
  AAVE_SUBGRAPH_API_KEY:
    process.env.AAVE_SUBGRAPH_API_KEY ??
    process.env.GRAPH_API_KEY ??
    process.env.THE_GRAPH_API_KEY,
  ETHEREUM_RPC_URL: rpcUrlResult?.success ? rpcUrlResult.data : undefined,
  MORPHO_RPC_URL: morphoRpcUrlResult?.success ? morphoRpcUrlResult.data : undefined
});

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;
