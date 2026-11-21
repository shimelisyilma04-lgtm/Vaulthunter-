import { config } from "../config.js";
import { MorphoStore } from "./store.js";
import { PostgresMorphoStore } from "./postgres-store.js";
import type { MorphoStorePort } from "./store-port.js";

export function createMorphoStore(): MorphoStorePort {
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
    throw new Error("Morpho historical indexing requires DATABASE_URL in production; refusing ephemeral SQLite storage.");
  }
  if (config.DATABASE_URL) {
    console.info("VaultHunter Morpho storage backend: PostgreSQL (durable external database)");
    return new PostgresMorphoStore(config.DATABASE_URL);
  }
  console.warn("VaultHunter Morpho storage backend: local SQLite (development only)");
  return new MorphoStore(config.VAULTHUNTER_DB_PATH);
}
