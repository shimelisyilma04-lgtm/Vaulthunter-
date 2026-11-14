# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity and Aave V3 Pool address resolution.
- Bounded recent-event scanner for quick checks (configurable 1–10,000 block window; recent Borrow-event discovery only).
- Read-only HTTP API and live dashboard for service health, indexer status, borrowers, events, scans, and liquidation estimates.
- Conservative Aave V3 liquidation profitability screening calculator with close-factor, collateral-cap, protocol-fee, flash-loan, swap, slippage, gas, and safety-buffer inputs.
- SQLite-backed incremental Aave V3 historical Borrow-event indexer.
- Durable event ledger, borrower aggregates, block-hash checkpoints, and confirmation-depth reorg rewind.
- Current health-factor snapshots for indexed borrowers.
- No wallet, private key, transaction signing, or transaction submission.

## Dashboard preview

The responsive dashboard is served by the Node API at the Render service root and reads API-backed data. It includes live service/indexer status, recent scan output, borrower snapshots, and a caller-input profitability sandbox. Empty data states are real; the dashboard does not invent borrower metrics. No wallet connection or transaction execution is included.

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

The SQLite database defaults to `./data/vaulthunter.sqlite`. Use a persistent disk for hosted deployments. See [historical indexer setup](docs/AAVE_INDEXER.md).

## Read-only HTTP API

The deployed service exposes:

- `GET /healthz` — process health.
- `GET /api/v1/status` — RPC configuration, indexer state, checkpoint, and stored counts.
- `GET /api/v1/scan?lookbackBlocks=100` — bounded recent Borrow-event scan (1–500 blocks; requires a valid Ethereum Mainnet RPC URL).
- `GET /api/v1/positions?user=0x...` — enrich a known borrower with AaveKit supply/borrow positions and account state (indexed data, not pinned to the RPC scan block).
- `GET /api/v1/borrowers?limit=200` — stored borrower snapshots.
- `GET /api/v1/candidates?limit=100` — stored snapshots currently flagged below HF 1.
- `GET /api/v1/events?limit=50` — recent indexed Borrow events.
- `GET /api/v1/estimate?... ` — caller-input Aave V3 liquidation screening estimate. Required query parameters: `healthFactor`, `totalDebtUsd`, `debtReserveUsd`, `collateralReserveUsd`, `collateralAvailableUsd`, `liquidationBonusBps`, and `gasCostUsd`. Optional: `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, `protocolFeeBps`, and `safetyBufferBps`.

The estimate endpoint does not fetch or certify prices, reserve configuration, DEX quotes, flash-loan availability, or gas prices. Supply fresh same-block, pair-specific inputs from a trusted market adapter. A positive estimate is only a screening signal; pinned-block revalidation and exact transaction simulation are mandatory before any future execution. See [API and bot integration](docs/API.md).

## Other commands

```bash
npm run typecheck
npm test
npm run aave:scan
```

## Safety and scope

The historical indexer discovers borrowers from Pool Borrow events. It does not prove that a borrower is currently liquidatable or that a liquidation is profitable. Health-factor snapshots can become stale immediately. Any future execution path requires pinned-block revalidation, protocol-specific close-factor and reserve checks, exact transaction simulation, conservative gas/slippage modelling, risk controls, and independent security review.

Execution is deliberately disabled. This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
