# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity and Aave V3 Pool address resolution.
- Bounded recent-event scanner for quick checks.
- SQLite-backed incremental Aave V3 historical Borrow-event indexer.
- Durable event ledger, borrower aggregates, block-hash checkpoints, and confirmation-depth reorg rewind.
- Current health-factor snapshots for indexed borrowers.
- No wallet, private key, transaction signing, or transaction submission.

## Dashboard preview

A responsive static dashboard preview is available in `dashboard/index.html`. It currently uses clearly labeled illustrative sample data; it is not connected to the SQLite indexer or a live API. The repository is private, so publish the preview through Render after connecting the GitHub repository in Render Account Settings → Account Security → Git Deployment Credentials. Create a Static Site using branch `main`, publish directory `dashboard`, and an empty build command (or `echo ready`). No wallet connection or transaction execution is included.

## Run the Aave historical indexer

Requires Node.js 20+ and an Ethereum Mainnet RPC endpoint. On Windows, run `powershell -ExecutionPolicy Bypass -File .\\scripts\\start-indexer.ps1` for one pass, or add `-Continuous` to keep indexing while your computer is on. The script creates `.env` and asks for the RPC endpoint if needed.

1. Copy `.env.example` to `.env`.
2. Set `ETHEREUM_RPC_URL` to your Ethereum Mainnet RPC endpoint. Keep it private; do not commit `.env`.
3. The default `AAVE_INDEXER_START_BLOCK=16291127` is the documented Ethereum Aave V3 Pool deployment/start block. Change it only if you intentionally want a later partial index.
4. Run a one-shot pass or continuous indexer:

```bash
npm install
npm run aave:index:once
# or
npm run aave:index
```

The SQLite database defaults to `./data/vaulthunter.sqlite`. Use a persistent disk for hosted deployments. When borrower snapshots are refreshed, the indexer logs accounts with nonzero debt and health factor below 1, ranked by lowest health factor. Each result includes its observed block so stale candidates can be rejected. See [historical indexer setup](docs/AAVE_INDEXER.md).

## Other commands

```bash
npm run typecheck
npm test
npm run aave:scan
```

## Safety and scope

The historical indexer discovers borrowers from Pool Borrow events. It does not prove that a borrower is currently liquidatable or that a liquidation is profitable. Health-factor snapshots can become stale immediately. Any future execution path requires pinned-block revalidation, protocol-specific close-factor and reserve checks, exact transaction simulation, conservative gas/slippage modelling, risk controls, and independent security review.

Execution is deliberately disabled. This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
