# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity and Aave V3 Pool address resolution.
- Bounded recent-event Aave scanner.
- SQLite-backed incremental Aave V3 historical Borrow-event indexer with borrower records, block-hash checkpoints, and reorg rewind.
- Current Aave health-factor snapshots for indexed borrowers.
- Unit-tested Aave liquidation-bonus profitability estimator; live reserve-level quoting is not yet integrated.
- Morpho Blue Ethereum market discovery, on-chain borrower-event indexing, IRM-based accrued-debt screening, and a tested protocol-math liquidation quote calculator (not yet connected to live candidates).
- No wallet, private key, transaction signing, or transaction submission.

## Aave V3 historical discovery

Requires Node.js 20+ and an Ethereum Mainnet RPC endpoint. Copy `.env.example` to `.env`, set `ETHEREUM_RPC_URL`, and keep the endpoint private.

```bash
npm install
npm run aave:index:once
npm run aave:index
```

The indexer starts at Aave V3 Ethereum's Pool deployment block (16,291,127 by default), resumes from SQLite checkpoints, and refreshes borrower account data after it catches up. Keep the process running and store `VAULTHUNTER_DB_PATH` on persistent storage. Full historical discovery can take many hours or days on rate-limited RPC plans.

A resumable GitHub Actions workflow is also available: **Actions → Aave V3 Historical Backfill → Run workflow**. It requires the repository Actions secret `ETHEREUM_RPC_URL`, saves the SQLite cache between scheduled runs, and publishes a seven-day database artifact. See [Aave indexer instructions](docs/AAVE_INDEXER.md).

## Aave profitability analysis

`src/aave/profitability.ts` estimates the liquidation bonus value and subtracts gas, swap, flash-loan, builder and safety-margin costs. This is a tested calculation component, not yet a live per-borrower quote. Live reserve-level balances, reserve liquidation bonus, prices, close-factor limits, gas and swap quotes still need to be fetched and simulated. See [Aave profitability notes](docs/AAVE_PROFITABILITY.md).

## Morpho Blue scanner

Morpho market configuration is discovered through the official public REST API. Borrower addresses are found from on-chain position events; positions, market totals and oracle prices are read from Ethereum RPC. The scanner uses SQLite checkpoints and is Ethereum Mainnet-only in this version.

```bash
npm run morpho:scan:once
npm run morpho:scan
```

The continuous command resumes historical event discovery and refreshes rotating borrower snapshots. The scanner now applies the market IRM's `borrowRateView` and Morpho's Taylor-compounded interest math at a pinned block, including virtual-share debt rounding. `src/morpho/liquidation-quote.ts` reproduces Morpho's repay/seize calculation for a supplied repay-share amount and checks collateral/liquidity sufficiency. It is not yet wired into live scanner candidates, DEX quoting, or transaction simulation. See [Morpho scanner instructions](docs/MORPHO_SCANNER.md).

## Validation gates

`src/domain/validation.ts` provides fail-closed evidence checks for future liquidation quote and simulation adapters. It rejects stale or mixed-block evidence, missing protocol accounting, failed simulations and insufficient estimated net profit. A passing result is only `simulation_review`; it never authorizes a transaction. See [validation gate requirements](docs/VALIDATION_GATES.md).

## Other commands

```bash
npm run typecheck
npm test
npm run build
npm run aave:scan
```

## Safety and scope

These scanners identify potential liquidation-risk positions; they do not prove a liquidation is executable or profitable. Health-factor snapshots can become stale immediately. Any future execution path requires exact interest accrual, pinned-block revalidation, protocol-specific liquidation constraints, exact transaction simulation, conservative gas/slippage modelling, risk controls, and independent security review.

Execution is deliberately disabled. This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
