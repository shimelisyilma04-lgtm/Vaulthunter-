# Aave V3 historical borrower indexer

## What it does

- Indexes Aave V3 Ethereum Pool `Borrow` events incrementally.
- Persists events, distinct borrowers, and block checkpoints in SQLite.
- Uses a configurable confirmation depth and verifies the checkpoint block hash before continuing.
- Rewinds the configured confirmation window and rebuilds borrower aggregates when a checkpoint hash changes.
- Refreshes each known borrower's current account data and flags health factors below 1 with nonzero debt.
- Runs once or continuously; it never signs or submits transactions.

## First-time setup

1. Configure `ETHEREUM_RPC_URL` with an Ethereum Mainnet endpoint.
2. The default `AAVE_INDEXER_START_BLOCK=16291127` is the documented Ethereum Aave V3 Pool deployment/start block. This is the historical scan start, not a recent transaction block.
3. Set `VAULTHUNTER_DB_PATH` to a persistent local path, for example `./data/vaulthunter.sqlite`.
4. Run `npm run aave:index:once` to verify one pass, or `npm run aave:index` to keep indexing.

The first backfill begins at block 16,291,127 and advances in small sequential ranges. A full historical backfill can take a long time on free RPC plans; do not increase request concurrency to bypass provider limits. Start with the one-shot command and inspect its logs before leaving the continuous process running.

## Configuration

- `AAVE_INDEXER_START_BLOCK`: default 16291127 for a fresh full-history index; set a later block only when intentionally creating a partial history.
- `AAVE_INDEXER_CONFIRMATIONS`: confirmation depth (default 12).
- `AAVE_INDEXER_BATCH_BLOCKS`: blocks per `eth_getLogs` request (default 10, maximum 10).
- `AAVE_INDEXER_POLL_INTERVAL_MS`: continuous polling interval (default 30 seconds).
- `AAVE_INDEXER_SNAPSHOT_BATCH_SIZE`: maximum borrowers refreshed per pass (default 100); oldest snapshots are refreshed first so large markets rotate fairly.
- `VAULTHUNTER_DB_PATH`: SQLite database path (default `./data/vaulthunter.sqlite`).

## Reorg and durability notes

Each committed batch writes decoded events and its checkpoint in one SQLite transaction. The stored checkpoint block hash is checked before every pass. If it no longer matches the canonical chain, events after the confirmation-depth rewind point are deleted and borrower aggregates are rebuilt.

Use a persistent disk/volume for `VAULTHUNTER_DB_PATH` in any hosted deployment. Ephemeral container filesystems lose the index when a service restarts or redeploys. Back up the database file and its SQLite WAL consistently; stop the service or use SQLite's backup API for a clean backup.

This is an event index, not a guarantee that every account is currently eligible. Health snapshots are time-sensitive and must be refreshed and revalidated at the same block as any future transaction simulation.
