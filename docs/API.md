# VaultHunter read-only API and simulation interfaces

Base URL: `https://vaulthunter-core.onrender.com`

VaultHunter exposes read-only market/indexer endpoints plus an optional, bearer-token-protected fork simulation endpoint. It does not create liquidation calldata, sign transactions, or broadcast transactions.

## Main endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Process health |
| GET | `/api/v1/status` | RPC/indexer/storage status and indexed counts |
| GET | `/api/v1/scan?lookbackBlocks=100` | Bounded recent Aave V3 Borrow-event scan |
| GET | `/api/v1/market` | Aave V3 Ethereum reserve metadata/liquidity from AaveKit (not block-pinned) |
| GET | `/api/v1/positions?user=0x...` | AaveKit position enrichment (not block-pinned) |
| GET | `/api/v1/positions/onchain?user=0x...` | Confirmed-block Aave reserve balances, oracle prices, eMode category and reserve membership |
| GET | `/api/v1/opportunities?limit=20` | Recheck previously flagged borrowers at confirmed blocks |
| GET | `/api/v1/opportunities/estimate?user=0x...&gasCostUsd=...` | Pair-specific Aave screening estimates from on-chain reserve state |
| GET | `/api/v1/borrowers?limit=100` | Stored borrower snapshots |
| GET | `/api/v1/candidates?limit=100` | Stored snapshots flagged below health factor 1 |
| GET | `/api/v1/risk?limit=100` | Health-factor-ranked known borrowers with snapshot age/freshness |
| GET | `/api/v1/events?limit=50` | Recent indexed Borrow events |
| GET | `/api/v1/discovery/subgraph` | Bounded Aave official subgraph borrower discovery (requires Graph key) |
| GET | `/api/v1/quote/uniswap-v3?... ` | Single-pool Uniswap V3 QuoterV2 quote |
| GET | `/api/v1/quote/uniswap-v3/best?... ` | Four standard fee tiers for one token pair |
| GET | `/api/v1/quote/uniswap-v3/path?tokens=0xA,0xB,0xC&amountIn=...` | Search fee tiers for a supplied 1–3 hop token path |
| GET | `/api/v1/execution-costs?... ` | Integer-based conservative execution-cost budget in USD cents |
| GET | `/api/v1/estimate?... ` | Caller-input Aave liquidation screening estimate |
| GET | `/api/v1/simulation/status` | Fork simulator configuration status |
| POST | `/api/v1/simulation/fork` | Read-only `eth_call` and gas estimate against a verified Anvil fork |

## eMode-aware position and estimate behavior

The on-chain position adapter reads the user's eMode category, category LTV/liquidation threshold/liquidation bonus/price-source address, and each reserve's eMode category from the reserve configuration bitmap. For a pair where both selected reserves match the user's eMode category, it uses the category liquidation bonus only when the category does not override the price source.

If the category has a non-zero custom price source, automatic USD profitability estimates are withheld. The custom price feed is surfaced but is not yet normalized to the market base currency. Estimates are also withheld when the Aave market base currency is not USD. This is deliberate: an unsupported price source must not silently produce a false profit estimate.

`/api/v1/opportunities/estimate` requires a borrower address and `gasCostUsd`. Optional fee parameters are `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, and `safetyBufferBps`. It uses the reserve-level liquidation protocol fee from Aave's reserve configuration. Results are screening estimates, not proof of a successful liquidation.

## Multi-hop Uniswap route screening

The `/path` endpoint accepts 2–4 comma-separated token addresses (1–3 hops) and `amountIn` in the input token's smallest units. It tests all 4 standard Uniswap V3 fee tiers (100, 500, 3000, 10000) for each hop: up to 4, 16, or 64 paths. It reports successful quotes, raw output and Quoter gas estimate at one block.

The endpoint only evaluates the token sequence supplied by the caller; it does not discover intermediate tokens or compare other DEXs. Raw output is not net profit. A route can still fail because of Aave settlement rules, flash-loan callback behavior, gas, MEV, slippage or state drift.

## Execution-cost budget

`/api/v1/execution-costs` accepts integer strings for `grossProfitUsdCents`, `gasLimit`, `maxFeePerGasWei`, `nativeAssetPriceUsdWad`, `flashLoanPrincipalUsdCents`, `swapNotionalUsdCents`, and `builderFeeUsdCents`. Optional basis-point parameters are `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, and `safetyBufferBps`.

Gas is budgeted using `gasLimit × maxFeePerGasWei`, then converted using the caller-supplied native-asset USD price. Fee buckets are rounded up. All USD values and the native-asset price must refer to a consistent market snapshot. The calculator does not fetch or verify these prices and is not an execution quote.

## Isolated Anvil fork simulation

The optional simulator requires both:

- `ETHEREUM_FORK_RPC_URL`: a private Anvil node started in Ethereum mainnet fork mode. The service verifies `anvil_nodeInfo` reports an active fork before running calls.
- `VAULTHUNTER_SIMULATION_API_TOKEN`: a random secret of at least 32 characters.

The request requires `Authorization: Bearer <token>` and a JSON body:

```json
{
  "to": "0x0000000000000000000000000000000000000001",
  "data": "0x",
  "value": "0",
  "from": "0x0000000000000000000000000000000000000002"
}
```

The endpoint runs `eth_call` and `eth_estimateGas` against the same confirmed fork block. It never calls `eth_sendTransaction`, `eth_sendRawTransaction`, or a signing method. The caller must provide complete calldata for the transaction it wants to test. A complete, audited Aave flash-loan liquidation executor and calldata builder are not included in this repository.

Never point the fork RPC variable at a public mainnet RPC or transaction broadcaster. Do not send private keys, seed phrases, or signing credentials to VaultHunter.

## Discovery and operational limits

- The RPC scanner discovers borrowers from recent Pool Borrow events; it is not a global market-wide borrower directory.
- The indexer starts from a bounded recent window unless an explicit historical start block is configured. Full-history backfill can require millions of RPC log requests.
- The official Aave subgraph integration reads a bounded recent slice (up to 1,000 Borrow events) and is not an exhaustive all-time borrower census.
- The automatic opportunities endpoint only rechecks previously discovered and flagged borrowers.
- Snapshot data can become stale immediately. Revalidate all positions and reserve state at one pinned block.
- In-memory rate limits reset on restart and are not a distributed API gateway or production SLA.
- Render's local SQLite filesystem may be ephemeral; use durable PostgreSQL for hosted historical indexing.

## Safety and scope

VaultHunter is an experimental, read-only liquidation-intelligence and simulation project. It has no autonomous liquidation execution path. A positive estimate or successful Quoter response is not a profit guarantee. Any future execution system requires a complete independently audited executor, exact fork simulation, live state revalidation, robust key custody, risk limits, monitoring and professional security review.
