# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity and Aave V3 Pool address resolution.
- Bounded recent-event scanner for quick checks (configurable 1–10,000 block window; recent Borrow-event discovery only).
- Read-only HTTP API and live dashboard for service health, indexer status, borrowers, events, scans, automatic candidate rechecks, and liquidation estimates.
- Conservative Aave V3 liquidation profitability screening calculator with account-level close-factor cap, collateral cap, reserve protocol fee, $1,000 partial-liquidation dust checks, flash-loan, swap, slippage, gas, and safety-buffer inputs.
- Morpho Blue position snapshots accrue market borrow assets from the market IRM's `borrowRateView` at the observed block timestamp using Morpho's three-term Taylor compounding and virtual-share conversions; accrued debt feeds the live opportunity screen.
- SQLite-backed incremental Aave V3 historical Borrow-event indexer.
- Durable event ledger, borrower aggregates, block-hash checkpoints, and confirmation-depth reorg rewind.
- Current health-factor snapshots and a ranked read-only risk feed for indexed borrowers. Snapshot refresh batches rotate through the full known-borrower set instead of repeatedly refreshing only the first page.
- Confirmed-block Aave Protocol Data Provider and Aave Oracle enrichment for reserve balances, oracle prices, reserve eMode-category membership, liquidation protocol fee, category parameters, and collateral/debt screening pairs. The category liquidation bonus is applied when the selected collateral reserve matches the user category and no category price-source override exists; custom eMode price feeds remain explicitly unsupported until safely normalized.
- Automatic `/api/v1/opportunities` rechecks for previously flagged borrowers, with bounded concurrency, short caching, and per-wallet confirmed-block state reads.
- Optional Aave-maintained Ethereum V3 subgraph discovery adapter (requires a The Graph API key; bounded recent history, not exhaustive).
- Read-only Base and Arbitrum Aave V3/Morpho Blue recent-event discovery, followed by same-block live borrower/market position refresh and ranked net-profit estimates.
- Read-only Uniswap V3 QuoterV2 single-pool and same-block multi-hop path quote screening across Ethereum, Base and Arbitrum. For a supplied 1–3 hop token sequence, up to 64 standard fee-tier combinations are checked; best raw output and estimated gas are screening data only.
- Integer-only execution-cost budget using max EIP-1559 gas exposure, native-asset USD price, flash-loan fee, swap fee, slippage, builder fee, and safety buffer; values are rounded conservatively in USD cents.
- Optional isolated Ethereum, Base and Arbitrum Anvil fork simulator: token-protected `eth_call` plus `eth_estimateGas` against a verified chain-matched fork node. It requires complete calldata from a separately audited executor; VaultHunter does not build, sign, or submit liquidation transactions.
- No wallet, private key, transaction signing, or transaction submission.

## Independent protocol verification and executor test boundary

- `npm run verify:protocol-deployments` fingerprints Aave Pool proxy/implementation bytecode and Morpho Blue singleton bytecode on Base and Arbitrum at pinned blocks. See [deployment fingerprints](docs/DEPLOYMENT_FINGERPRINTS.md) and the [independent protocol review](docs/INDEPENDENT_PROTOCOL_REVIEW.md).
- `npm run aave:l2:smoke` performs read-only reserve-adapter smoke checks against Base and Arbitrum.
- `forge test -vvv` runs the isolated, test-only callback/rollback architecture harness in `test-solidity/ExecutorArchitecture.t.sol`. It uses mock protocols and tokens; it is not production executor code and must never be deployed.
- `forge test --match-contract ProtocolForkVerificationTest -vvv` checks live Base/Arbitrum deployments and compares Morpho accrual against deployed core on a local fork. See [fork verification](test-solidity/ProtocolForkVerification.t.sol) and the [production release gates](docs/PRODUCTION_RELEASE_GATES.md).
- The multichain opportunity screen is still an estimate, not a validated executable profit. Gas units and MEV/builder budgets are caller-supplied, only direct-pool quotes are included in the Morpho screen, and exact fork differential tests with a reviewed executor are outstanding.

## Dashboard preview

The responsive dashboard is served by the Node API at the Render service root and reads API-backed data. It includes live service/indexer status, recent scan output, borrower snapshots, automatic live liquidation rechecks, market data, and a caller-input profitability sandbox. Empty data states are real; the dashboard does not invent borrower metrics. No wallet connection or transaction execution is included.

## Run the Aave historical indexer

Requires Node.js 20+ and an Ethereum Mainnet RPC endpoint. On Windows, run `powershell -ExecutionPolicy Bypass -File .\\scripts\\start-indexer.ps1` for one pass, or add `-Continuous` to keep indexing while your computer is on. The script creates `.env` and asks for the RPC endpoint if needed.

1. Copy `.env.example` to `.env`.
2. Set `ETHEREUM_RPC_URL` to your Ethereum Mainnet RPC endpoint. Keep it private; do not commit `.env`.
3. Leave `AAVE_INDEXER_START_BLOCK` unset for a safe recent-window bootstrap (the last `AAVE_SCAN_LOOKBACK_BLOCKS`, 100 by default), then continuous indexing follows new blocks. Set `AAVE_INDEXER_START_BLOCK=16291127` only when you intentionally want a full-history backfill; this can require millions of RPC log requests and is not recommended on a free RPC tier.
4. Run a one-shot pass or continuous indexer:

```bash
npm install
npm run aave:index:once
# or
npm run aave:index
```

The local SQLite database defaults to `./data/vaulthunter.sqlite`. Hosted deployments can use PostgreSQL by setting `DATABASE_URL`; the indexer remains disabled until `AAVE_INDEXER_ENABLED=true` is explicitly set. For a $0 persistent development database, see [Neon](https://console.neon.tech/) and the [historical indexer setup](docs/AAVE_INDEXER.md).

## Read-only HTTP API

The deployed service exposes:

- `GET /healthz` — process health.
- `GET /api/v1/status` — RPC configuration, indexer state, checkpoint, and stored counts.
- `GET /api/v1/scan?lookbackBlocks=100` — bounded recent Borrow-event scan (1–500 blocks; requires a valid Ethereum Mainnet RPC URL).
- `GET /api/v1/market` — current Aave V3 Ethereum market and reserve data, including liquidation bonuses, liquidity, oracle addresses, and flash-loan flags (AaveKit indexed data, not block-pinned).
- `GET /api/v1/positions?user=0x...` — enrich a wallet with AaveKit supply/borrow positions and account state (indexed data, not pinned to the RPC scan block).
- `GET /api/v1/positions/onchain?user=0x...` — read reserve-level positions, oracle prices, base-currency values, health factor, reserve eMode-category membership, and category parameters at one confirmed block. Custom non-zero eMode price-source feeds are reported but not converted.
- `GET /api/v1/opportunities?limit=20` — recheck up to 20 previously flagged borrowers on-chain and return possible collateral/debt pairs; bounded to five requests per minute and cached briefly.
- `GET /api/v1/opportunities/estimate?user=0x...&gasCostUsd=...` — calculate pair-specific Aave screening estimates from same-block reserve balances and USD-base oracle values. It refuses custom eMode price-source categories and non-USD base currencies. Optional fee parameters: `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, `safetyBufferBps`.
- `GET /api/v1/borrowers?limit=200` — stored borrower snapshots.
- `GET /api/v1/risk?limit=100` — lowest-health-factor-first risk feed with snapshot age/freshness.
- `GET /api/v1/discovery/subgraph` — up to 1,000 recent Aave V3 Borrow events, deduplicated to borrower addresses; requires `AAVE_SUBGRAPH_API_KEY` in the Render environment (also accepts `GRAPH_API_KEY` or `THE_GRAPH_API_KEY`); the live indexer syncs it every `AAVE_SUBGRAPH_SYNC_INTERVAL_MS` (default 900000 ms).
- `GET /api/v1/discovery/multichain?network=base|arbitrum&lookbackBlocks=10000` — bounded recent Aave V3 Borrow and Morpho Blue market/borrow/collateral event discovery.
- `GET /api/v1/positions/multichain?network=base|arbitrum&lookbackBlocks=10000` — discovers recent borrowers, then refreshes their current Aave account data and Morpho market positions at one pinned block per read.
- `GET /api/v1/quote/uniswap-v3/multichain?network=base|arbitrum&tokenIn=0x...&tokenOut=0x...&amountIn=1000000` — same-block Base/Arbitrum Uniswap V3 QuoterV2 fee-tier quote screening.
- `GET /api/v1/quote/uniswap-v3?tokenIn=0x...&tokenOut=0x...&amountIn=1000000&fee=500` — single-pool Uniswap V3 quote; amount is in token base units.
- `GET /api/v1/quote/uniswap-v3/best?tokenIn=0x...&tokenOut=0x...&amountIn=1000000` — quotes fee tiers 100, 500, 3000, and 10000 at one pinned block; returns every available pool quote and the highest raw output.
- `GET /api/v1/quote/uniswap-v3/path?tokens=0xTokenA,0xTokenB,0xTokenC&amountIn=1000000` — checks all 16 fee-tier combinations for a two-hop path (up to 64 for three hops) at one block.
- `GET /api/v1/execution-costs?...` — integer-based conservative USD-cent cost and net-profit budget. Required values: `grossProfitUsdCents`, `gasLimit`, `maxFeePerGasWei`, `nativeAssetPriceUsdWad`, `flashLoanPrincipalUsdCents`, `swapNotionalUsdCents`, and `builderFeeUsdCents`. Optional basis points: `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, `safetyBufferBps`.
- `GET /api/v1/simulation/status` — reports fork simulation configuration.
- `POST /api/v1/simulation/fork` — simulates caller-supplied Ethereum contract calldata with `eth_call` and `eth_estimateGas` on a verified private Anvil fork.
- `POST /api/v1/simulation/multichain` — same read-only fork simulation for Base and Arbitrum. JSON body: `{ "network": "base", "to": "0x...", "data": "0x...", "from": "0x..." }` (optional `value`). Requires the simulation bearer token.
- `POST /api/v1/simulation/aave-liquidation` — builds and simulates a direct Aave V3 `liquidationCall`; the `from` address must have debt-token balance and allowance on the fork. Both endpoints require the simulation bearer token and never submit transactions.
- `GET /api/v1/opportunities/multichain?network=base&gasUnits=...` — bounded recent Aave V3 and Morpho Blue discovery, accrued Morpho debt, reserve-specific Aave pair estimates, same-block direct Uniswap V3 quotes, Aave flash-loan premium/liquidity, gas-price conversion, and caller-specified slippage/MEV/builder/safety budgets. Use `network=arbitrum` for Arbitrum. The gas limit is caller-supplied, so results remain screening estimates.
- `POST /api/v1/simulation/aave-liquidation/multichain` — simulates a directly funded Aave V3 Base/Arbitrum `liquidationCall` on a private Anvil fork. JSON includes `network`, `collateralAsset`, `debtAsset`, `borrower`, `debtToCover`, `receiveAToken`, and `from`.
- `POST /api/v1/simulation/morpho-liquidation/multichain` — simulates a directly funded Morpho Blue liquidation on a private Base/Arbitrum Anvil fork. JSON includes `network`, `marketId`, `borrower`, `from`, and exactly one positive amount: `seizedAssets` or `repaidShares`.
- `GET /api/v1/candidates?limit=100` — stored snapshots currently flagged below HF 1.
- `GET /api/v1/events?limit=50` — recent indexed Borrow events.
- `GET /api/v1/estimate?... ` — caller-input Aave V3 liquidation screening estimate. Required query parameters: `healthFactor`, `totalDebtUsd`, `debtReserveUsd`, `collateralReserveUsd`, `collateralAvailableUsd`, `liquidationBonusBps`, and `gasCostUsd`. Optional: `flashLoanFeeBps`, `swapFeeBps`, `slippageBps`, `protocolFeeBps`, and `safetyBufferBps`.

The market endpoint retrieves current Aave reserve metadata and market liquidity from AaveKit. Uniswap route quotes compare output and Quoter gas estimates but do not include Aave settlement, flash-loan callback success, gas-price conversion, builder/MEV, or state drift. The fork simulator can test either caller-supplied calldata or a direct-funded Aave `liquidationCall`; it does not create a flash-loan executor. Configure `ETHEREUM_FORK_RPC_URL`, `BASE_FORK_RPC_URL`, or `ARBITRUM_FORK_RPC_URL` to private Anvil forks for the corresponding chain, and `VAULTHUNTER_SIMULATION_API_TOKEN` to a random secret of at least 32 characters. The multichain endpoint accepts only chain IDs 8453 and 42161 and verifies Anvil fork metadata before calling. Never point the fork variable at a mainnet broadcaster. The Aave subgraph adapter is optional and disabled until a Graph API key is configured. When configured, the live indexer periodically reads a bounded recent slice (default every 15 minutes), upserts discovered addresses into durable storage, and refreshes their current account state from Ethereum RPC. It does not claim exhaustive historical coverage. The automatic opportunity endpoint only rechecks accounts previously discovered and flagged by the indexer; it is not global borrower discovery. The reserve-level endpoint reads each wallet’s balances and health factor at one confirmed block. The estimate endpoint still does not certify same-block market prices, flash-loan route availability, or gas prices. Supply fresh same-block, pair-specific inputs from a trusted market adapter. A positive estimate is only a screening signal; pinned-block revalidation and exact transaction simulation are mandatory before any future execution. A flash-loan executor and callback are not implemented. The new protocol-specific fork helpers simulate directly funded Aave/Morpho calls only; they do not test a flash-loan callback, swap, repayment or atomic full transaction. All simulation endpoints require the bearer token and never submit transactions. See [API and bot integration](docs/API.md).

## Other commands

```bash
npm run typecheck
npm test
npm run aave:scan
```

See [liquidation math and validation boundaries](docs/LIQUIDATION_MATH.md) for protocol formulas and the remaining requirements before any future execution.

## Independent protocol review and isolated executor tests

- Source-level verification notes, known chain-version limitations and the pre-execution safety gate: [docs/INDEPENDENT_PROTOCOL_REVIEW.md](docs/INDEPENDENT_PROTOCOL_REVIEW.md).
- The Foundry suite in `test-solidity/ExecutorArchitecture.t.sol` is a **test-only mock harness** for Aave/Morpho callback order, repayment, min-output, minimum-profit, reentrancy rejection and atomic rollback. It is not a production executor.
- Run the isolated Solidity suite with `forge test -vvv`. GitHub Actions runs it separately from the TypeScript CI.
- Run `npm run verify:protocol-deployments` to fingerprint the live Aave Pool proxies/implementations and Morpho Blue singleton bytecode on Base and Arbitrum at pinned blocks. CI uses public RPC fallbacks unless `BASE_RPC_URL` / `ARBITRUM_RPC_URL` secrets are supplied.
- Run `npm run aave:l2:smoke` to read the deployed Base and Arbitrum Aave reserve lists and balances using the live Pool ABI. This uses a synthetic no-position address and does not attempt liquidation.
- Morpho read-only accrual now mirrors `borrowRateView`, the core three-term Taylor formula and virtual-share accounting.
- Aave reserve-level sizing now uses selected-reserve close-factor thresholds, eMode price-source rules and explicit liquidation rounding. Live Base/Arbitrum Pool implementation revisions still require pinned-block fork verification before estimates can be considered execution-ready.

## Safety and scope

The historical indexer discovers borrowers from Pool Borrow events. It does not prove that a borrower is currently liquidatable or that a liquidation is profitable. Health-factor snapshots can become stale immediately. Any future execution path requires pinned-block revalidation, protocol-specific close-factor and reserve checks, exact transaction simulation, conservative gas/slippage modelling, risk controls, and independent security review.

Execution is deliberately disabled. This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
