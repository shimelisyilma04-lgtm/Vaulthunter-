# VaultHunter read-only API and bot integration

Base URL: `https://vaulthunter-core.onrender.com`

All endpoints are read-only. The service does not accept wallet credentials, sign transactions, or submit transactions.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Process health |
| GET | `/api/v1/status` | RPC configuration, indexer state, checkpoint, and stored counts |
| GET | `/api/v1/scan?lookbackBlocks=100` | Scan a bounded recent Borrow-event window and read current account health |
| GET | `/api/v1/positions?user=0x...` | Enrich a known Ethereum borrower with AaveKit supply, borrow, and account-state data |
| GET | `/api/v1/borrowers?limit=100` | Stored borrower snapshots |
| GET | `/api/v1/candidates?limit=100` | Stored snapshots flagged below health factor 1 |
| GET | `/api/v1/events?limit=50` | Recent indexed Borrow events |
| GET | `/api/v1/estimate?... ` | Caller-input liquidation profitability screening |

## Scan semantics

The scanner discovers addresses from recent Aave V3 Pool `Borrow` events, then reads current account data. It is not an exhaustive market-wide borrower directory: borrowers with no Borrow event in the selected block window are not discovered. The scan is bounded to 1–500 blocks and internally splits log queries into small sequential ranges to respect provider limits. Results are cached briefly.

A health factor below 1 means the position is eligible by the health-factor test at the observation time. It does not prove that a specific debt/collateral pair can be liquidated or that execution is profitable.

## Position enrichment endpoint

Use `GET /api/v1/positions?user=0x...` to fetch the selected user's supplied and borrowed assets, token amounts, USD values, and Aave account summary through the official AaveKit GraphQL API. This is useful for bots that already have a candidate address and need reserve-level context. It does not enumerate every borrower in the market. AaveKit responses may be cached and are not guaranteed to match the RPC scan's block; the API marks this as `provider-indexed-not-pinned` and returns a warning.

## Profitability screening endpoint

Example (replace all values with fresh, real values from your own same-block market adapter):

```http
GET /api/v1/estimate?healthFactor=0.94&totalDebtUsd=10000&debtReserveUsd=5000&collateralReserveUsd=8000&collateralAvailableUsd=8000&liquidationBonusBps=500&gasCostUsd=12&flashLoanFeeBps=9&swapFeeBps=30&slippageBps=50&protocolFeeBps=1000&safetyBufferBps=500
```

Required values:
- `healthFactor`: current Aave account health factor.
- `totalDebtUsd`: total account debt value in USD.
- `debtReserveUsd`: this account's debt position value in the selected debt reserve.
- `collateralReserveUsd`: this account's collateral position value in the selected collateral reserve.
- `collateralAvailableUsd`: value of collateral available for the selected liquidation pair.
- `liquidationBonusBps`: reserve-specific liquidation bonus in basis points.
- `gasCostUsd`: conservative expected gas cost in USD.

Optional values default to zero, except `safetyBufferBps`, which defaults to 500 (5% of gross bonus):
- `flashLoanFeeBps`
- `swapFeeBps`
- `slippageBps`
- `protocolFeeBps`
- `safetyBufferBps`

The estimator uses Aave V3's standard 50% close factor, or up to 100% when health factor is at or below 0.95 or either selected reserve position is below $2,000. For partial liquidation it conservatively reserves at least $1,000 of debt and collateral. The exact current market configuration and deployed Pool logic remain authoritative; validate all rules against the selected market/version.

The response includes maximum estimated repayment, collateral seized, gross bonus, itemized costs, estimated net profit, and explicit warnings. It is a screening calculation, not a route quote, transaction simulation, or guarantee.

## Bot integration pattern

1. Poll `/api/v1/status` and require a healthy service and configured RPC.
2. Call `/api/v1/scan` with a conservative block window; treat the result as a candidate feed, not a complete market scan.
3. Enrich a known borrower with `/api/v1/positions?user=...`, then independently fetch the borrower's account data and each relevant reserve's configuration/prices at the same pinned block using a trusted market adapter.
4. Obtain a real executable DEX route quote and flash-loan terms. Do not use the estimator's default zero fees as evidence that a route is free.
5. Call `/api/v1/estimate` with the complete same-block values. Ignore any result with missing, stale, or mismatched inputs.
6. Before any future execution, simulate the exact liquidation transaction against a fork or supported simulation service, revalidate health factor and reserve liquidity, and apply independent profit/risk thresholds.
7. Keep transaction execution disabled until a separate security review and explicit operator approval are complete.

A minimal Node 20 polling client is included at [examples/poll-candidates.mjs](../examples/poll-candidates.mjs). Run it with:

```bash
VAULTHUNTER_API_URL=https://vaulthunter-core.onrender.com node examples/poll-candidates.mjs
```

It prints new read-only candidates as JSON and deduplicates them by borrower and observed block. It does not estimate routes or execute liquidations.

## Operational limits

- The hosted Render free filesystem is ephemeral. SQLite event history and checkpoints can disappear on restart/redeploy; do not rely on the hosted SQLite store as durable production indexing.
- Historical indexing is disabled by default. A complete historical scan from the Pool deployment block is large and can exhaust free RPC quotas.
- The public demo service is not an authenticated, rate-limited production trading API and has no uptime or latency SLA.
- Never send private keys, seed phrases, wallet passwords, or signing credentials to this API.
- VaultHunter is experimental software, not financial advice. Liquidations can lose money.
