# VaultHunter read-only API and bot integration

Base URL: `https://vaulthunter-core.onrender.com`

All endpoints are read-only. The service does not accept wallet credentials, sign transactions, or submit transactions.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Process health |
| GET | `/api/v1/status` | RPC configuration, indexer state, checkpoint, and stored counts |
| GET | `/api/v1/scan?lookbackBlocks=100` | Scan a bounded recent Borrow-event window and read current account health |
| GET | `/api/v1/market` | Current Aave V3 Ethereum market and reserve metadata/liquidity from AaveKit |
| GET | `/api/v1/positions?user=0x...` | Enrich a known Ethereum borrower with AaveKit supply, borrow, and account-state data |
| GET | `/api/v1/borrowers?limit=100` | Stored borrower snapshots |
| GET | `/api/v1/candidates?limit=100` | Stored snapshots flagged below health factor 1 |
| GET | `/api/v1/risk?limit=100` | Health-factor-ranked borrower snapshots with age/freshness labels |
| GET | `/api/v1/discovery/subgraph` | Up to 1,000 recent Aave V3 Borrow events deduplicated to borrower addresses; requires AAVE_SUBGRAPH_API_KEY |
| GET | `/api/v1/quote/uniswap-v3?tokenIn=0x...&tokenOut=0x...&amountIn=1000000&fee=500` | Single-pool Uniswap V3 QuoterV2 read-only quote at a pinned block |
| GET | `/api/v1/simulation/status` | Explicit status of the not-yet-configured full liquidation simulation runner |
| GET | `/api/v1/events?limit=50` | Recent indexed Borrow events |
| GET | `/api/v1/estimate?... ` | Caller-input liquidation profitability screening |

## Scan semantics

The scanner discovers addresses from recent Aave V3 Pool `Borrow` events, then reads current account data. It is not an exhaustive market-wide borrower directory: borrowers with no Borrow event in the selected block window are not discovered. The scan is bounded to 1–500 blocks and internally splits log queries into small sequential ranges to respect provider limits. Results are cached briefly.

A health factor below 1 means the position is eligible by the health-factor test at the observation time. It does not prove that a specific debt/collateral pair can be liquidated or that execution is profitable.

## Position enrichment endpoint

Use `GET /api/v1/market` to retrieve Aave V3 Ethereum reserve metadata, liquidation bonus and threshold values, available liquidity, oracle addresses, and flash-loan enabled flags. This is useful for trader bots to discover reserve pairs and screen routes. It is provider-indexed and not pinned to a specific RPC block; fetch exact configuration and oracle values at one pinned block before simulation.\n\nUse `GET /api/v1/positions?user=0x...` to fetch the selected user's supplied and borrowed assets, token amounts, USD values, and Aave account summary through the official AaveKit GraphQL API. This is useful for bots that already have a candidate address and need reserve-level context. It does not enumerate every borrower in the market. AaveKit responses may be cached and are not guaranteed to match the RPC scan's block; the API marks this as `provider-indexed-not-pinned` and returns a warning.


## Historical borrower discovery

The optional GET /api/v1/discovery/subgraph adapter queries Aave's official Ethereum V3 protocol subgraph through The Graph. It reads at most 1,000 recent Borrow events (10 pages of 100), deduplicates borrower addresses, and reports the observed timestamp range. It is bounded recent-history discovery, not an exhaustive all-time borrower census. The Graph API key must be stored as the Render secret environment variable AAVE_SUBGRAPH_API_KEY; never place it in a URL shared publicly or in source control. When the key is absent, the endpoint returns 503 and status reports the provider as not configured.

The subgraph is an indexed source. Its borrowers must still be refreshed with current Ethereum RPC account data before risk ranking. Aave documents the official Ethereum V3 deployment and pagination limits in its protocol-subgraphs repository.

## Risk ranking feed

Use GET /api/v1/risk?limit=100 to rank already-discovered borrowers by lowest health factor. The response includes a screening band and snapshot age; snapshots older than 60 seconds are marked stale. The ranking is limited to borrowers present in VaultHunter's local index and is not a market-wide directory. Health-factor bands are triage labels only.

## Uniswap V3 quote endpoint

Use GET /api/v1/quote/uniswap-v3?tokenIn=0x...&tokenOut=0x...&amountIn=1000000&fee=500 for an on-chain exact-input quote through the official Ethereum mainnet Uniswap V3 QuoterV2 contract. amountIn is an integer in the input token's smallest units. Supported fee tiers are 100, 500, 3000, and 10000. The response includes the block number, raw output amount, and QuoterV2 gas estimate.

This endpoint quotes one Uniswap V3 pool only. It does not search all fee tiers or multi-hop routes, and it does not account for Aave liquidation constraints, flash-loan fees, gas price, builder/MEV costs, or subsequent price movement. A quote is not a guarantee that a complete liquidation route can execute.

## Full transaction simulation status

GET /api/v1/simulation/status currently reports not_configured. Exact liquidation simulation is not implemented. A production-grade simulation requires a pinned forked state, the complete liquidation calldata, the flash-loan callback and DEX route, plus isolated execution and gas accounting. Do not treat a quote or positive screening estimate as proof of executability.

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

The estimator applies Aave V3's standard 50% close factor, or up to 100% when health factor is at or below 0.95 or the selected debt/collateral reserve position is below $2,000. The close factor is applied to the selected debt-reserve position, not aggregate portfolio debt. Repayment is capped by the selected collateral balance after the liquidation bonus; no arbitrary minimum residual balance is assumed. The deployed Pool logic and exact market configuration remain authoritative.

The response includes maximum estimated repayment, collateral seized, gross bonus, itemized costs, estimated net profit, and explicit warnings. It is a screening calculation, not a route quote, transaction simulation, or guarantee.

## Bot integration pattern

1. Poll `/api/v1/status` and require a healthy service and configured RPC.
2. Call `/api/v1/scan` with a conservative block window; treat the result as a candidate feed, not a complete market scan.
3. Fetch `/api/v1/market` for reserve discovery and `/api/v1/positions?user=...` for a known borrower's supplied/borrowed assets; independently fetch the borrower's account data and reserve configuration/prices at the same pinned block using RPC.
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
- Historical discovery is incomplete: the hosted indexer starts from a bounded recent window and follows new Borrow events. Aave's official subgraph is being evaluated for broad historical borrower discovery; no historical completeness is claimed.
- Never send private keys, seed phrases, wallet passwords, or signing credentials to this API.
- VaultHunter is experimental software, not financial advice. Liquidations can lose money.
