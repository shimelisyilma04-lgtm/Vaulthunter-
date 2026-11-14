# Aave V3 historical borrower indexer

## What it does

- Indexes Aave V3 Ethereum Pool `Borrow` events incrementally.
- Persists events, distinct borrowers, and block checkpoints in SQLite locally or PostgreSQL when `DATABASE_URL` is configured.
- Uses a configurable confirmation depth and verifies the checkpoint block hash before continuing.
- Rewinds the configured confirmation window and rebuilds borrower aggregates when a checkpoint hash changes.
- Refreshes each known borrower's current account data and flags health factors below 1 with nonzero debt.
- Runs once or continuously; it never signs or submits transactions.

## First-time setup

### Windows (zero-cost local run)

1. Install Node.js 20 LTS or newer from [nodejs.org](https://nodejs.org/) if it is not already installed.
2. Download or clone this repository to your Windows computer and open PowerShell in the repository folder.
3. Run one pass with `powershell -ExecutionPolicy Bypass -File .\\scripts\\start-indexer.ps1`. The script installs dependencies and asks for your Ethereum Mainnet RPC HTTPS endpoint only if `.env` does not already contain it.
4. To keep indexing while the computer is on, run `powershell -ExecutionPolicy Bypass -File .\\scripts\\start-indexer.ps1 -Continuous`. Keep the computer awake and connected to the internet. Press Ctrl+C to stop safely; the SQLite checkpoint is saved after each batch, so you can restart later.

The RPC endpoint is saved in the local `.env` file, which is ignored by Git. Never paste it into a GitHub issue, commit it, or send it in chat.

### Other operating systems

1. Configure `ETHEREUM_RPC_URL` with an Ethereum Mainnet endpoint.
2. For a safe initial run, leave `AAVE_INDEXER_START_BLOCK` unset. The indexer seeds from the last `AAVE_SCAN_LOOKBACK_BLOCKS` (100 by default) confirmed blocks, then follows new blocks continuously. Set `AAVE_INDEXER_START_BLOCK=16291127` only to explicitly request a full-history backfill.
3. Set `VAULTHUNTER_DB_PATH` to a persistent local path, for example `./data/vaulthunter.sqlite`.
4. Run `npm run aave:index:once` to verify one pass, or `npm run aave:index` to keep indexing.

With no explicit start block, the first pass seeds only the recent lookback window and then follows new blocks. This is the recommended hosted mode: it avoids silently launching a multi-year historical scan on a free RPC plan. An explicitly configured start block begins a historical backfill and advances in sequential ranges of at most 10 blocks; a full backfill from block 16,291,127 can require millions of RPC requests and may take a very long time or exhaust provider quotas. Do not increase request concurrency to bypass provider limits.

## Configuration

- `AAVE_INDEXER_START_BLOCK`: optional explicit starting block. If unset, safely seeds from the recent lookback window; set 16291127 only for a deliberate full-history backfill.
- `AAVE_INDEXER_CONFIRMATIONS`: confirmation depth (default 12).
- `AAVE_INDEXER_BATCH_BLOCKS`: blocks per `eth_getLogs` request (default 10, maximum 10).
- `AAVE_INDEXER_POLL_INTERVAL_MS`: continuous polling interval (default 30 seconds).
- `AAVE_INDEXER_SNAPSHOT_BATCH_SIZE`: maximum borrowers refreshed per pass (default 100); oldest snapshots are refreshed first so large markets rotate fairly.
- `DATABASE_URL`: optional PostgreSQL connection URL. Use this for hosted Render deployments so checkpoints and event history survive restarts.
- `VAULTHUNTER_DB_PATH`: local SQLite database path (default `./data/vaulthunter.sqlite`); used when `DATABASE_URL` is unset.

## Reorg and durability notes

Each committed batch writes decoded events and its checkpoint in one SQLite transaction. The stored checkpoint block hash is checked before every pass. If it no longer matches the canonical chain, events after the confirmation-depth rewind point are deleted and borrower aggregates are rebuilt.

For hosted Render Free, create a PostgreSQL project with a provider that retains free-tier data (for example [Neon Console](https://console.neon.tech/)), copy its pooled connection string, and add it to Render as the secret environment variable `DATABASE_URL`. Do not paste the connection string into GitHub or chat. Then set `AAVE_INDEXER_ENABLED=true` in Render. The code creates its tables automatically. Neon currently documents a $0 Free plan with limited storage/compute; check its current limits before starting a long historical backfill. Render Free local files are ephemeral, and Render's own Free Postgres expires after 30 days. Local SQLite remains suitable for development on a persistent computer.

This is an event index, not a guarantee that every account is currently eligible. Health snapshots are time-sensitive and must be refreshed and revalidated at the same block as any future transaction simulation.
