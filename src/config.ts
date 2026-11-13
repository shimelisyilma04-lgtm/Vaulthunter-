import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ETHEREUM_RPC_URL: z.string().url().optional().or(z.literal("")),
  AAVE_SCAN_LOOKBACK_BLOCKS: z.coerce.number().int().min(1).max(10000).default(2000),
  VAULTHUNTER_EXECUTION_ENABLED: z.literal("false").default("false")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;
