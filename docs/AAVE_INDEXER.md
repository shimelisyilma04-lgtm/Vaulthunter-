# Aave V3 historical borrower indexer

## What it does

- Indexes Aave V3 Ethereum Pool `Borrow` events incrementally.
- Persists events, distinct borrowers, and block checkpoints in SQLite.
- Uses a configurable confirmation depth and verifies the checkpoint block hash before continuing.
- Rewinds the configured confirmation window and rebuilds borrower aggregates when a checkpoint hash changes.
- Refreshes each known borrower's current account data and flags health factors below 1 with nonzero debt.
- Runs once or continuously; it never signs or submits transactions.

## First-time setup

1. Configure `ETHEREUM_RPC_URL`.
2. Set `AAVE_INDEXER_START_BLOCK` to the Ethereum deployment block of the Aave V3 Pool proxy (the official Pool address is resolved dynamically from the PoolAddressesProvider).
3. Set `VAULTHUNTER_DB_PATH` to a persistent local path, for example `./data/vaulthunter.sqlite`.
4. Run `npm run aave:index:once` to verify one pass, or `npm run aave:index` to keep indexing.

The first backfill begins at the configured start block and advances in small block ranges. A full historical backfill can take a long time on free RPC plans; do not increase request concurrency to bypass provider limits.

## Configuration

- `AAVE_INDEXER_START_BLOCK`: required only when creating a fresh index; must be a valid block at or before the Pool's first Borrow event.
- `AAVE_INDEXER_CONFIRMATIONS`: confirmation depth (default 12).
- `AAVE_INDEXER_BATCH_BLOCKS`: blocks per `eth_getLogs` request (default 10, maximum 10).
- `AAVE_INDEXER_POLL_INTERVAL_MS`: continuous polling interval (default 30 seconds).
- `VAULTHUNTER_DB_PATH`: SQLite database path (default `./data/vaulthunter.sqlite`).

## Reorg and durability notes

Each committed batch writes decoded events and its checkpoint in one SQLite transaction. The stored checkpoint block hash is checked before every pass. If it no longer matches the canonical chain, events after the confirmation-depth rewind point are deleted and borrower aggregates are rebuilt.

Use a persistent disk/volume for `VAULTHUNTER_DB_PATH` in any hosted deployment. Ephemeral container filesystems lose the index when a service restarts or redeploys. Back up the database file and its SQLite WAL consistently; stop the service or use SQLite's backup API for a clean backup.

This is an event index, not a guarantee that every account is currently eligible. Health snapshots are time-sensitive and must be refreshed and revalidated at the same block as any future transaction simulation.
