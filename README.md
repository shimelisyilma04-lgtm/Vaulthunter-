# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity and Aave V3 Pool address resolution.
- Bounded recent-event scanner for quick checks.
- SQLite-backed incremental Aave V3 historical Borrow-event indexer.
- Durable event ledger, borrower aggregates, block-hash checkpoints, and confirmation-depth reorg rewind.
- Current health-factor snapshots for indexed borrowers.
- No wallet, private key, transaction signing, or transaction submission.

## Run the Aave historical indexer

Requires Node.js 20+ and an Ethereum Mainnet RPC endpoint.

1. Copy `.env.example` to `.env`.
2. Set `ETHEREUM_RPC_URL`.
3. Set `AAVE_INDEXER_START_BLOCK` to the deployment block of the Aave V3 Ethereum Pool proxy. The indexer resolves the current Pool address from the official PoolAddressesProvider.
4. Run a one-shot pass or continuous indexer:

```bash
npm install
npm run aave:index:once
# or
npm run aave:index
```

The SQLite database defaults to `./data/vaulthunter.sqlite`. Use a persistent disk for hosted deployments. See [historical indexer setup](docs/AAVE_INDEXER.md).

## Other commands

```bash
npm run typecheck
npm test
npm run aave:scan
```

## Safety and scope

The historical indexer discovers borrowers from Pool Borrow events. It does not prove that a borrower is currently liquidatable or that a liquidation is profitable. Health-factor snapshots can become stale immediately. Any future execution path requires pinned-block revalidation, protocol-specific close-factor and reserve checks, exact transaction simulation, conservative gas/slippage modelling, risk controls, and independent security review.

Execution is deliberately disabled. This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
