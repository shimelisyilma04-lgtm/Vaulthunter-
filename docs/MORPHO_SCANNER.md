# Morpho Blue Ethereum scanner

## Data sources and coverage

- Discovers Morpho Blue market configuration through the public Morpho Core REST API: `GET https://api.morpho.org/v0/blue/markets?chain_id=1`.
- Discovers borrower activity from the Ethereum Morpho Blue singleton's `Borrow`, `Repay`, `SupplyCollateral`, `WithdrawCollateral`, and `Liquidate` events.
- Scans the singleton's event stream once across all discovered markets, with a single SQLite block-hash checkpoint. This avoids rescanning the same block range separately for every market.
- Reads borrower positions, market totals, and oracle prices from Ethereum RPC at a common observed block.
- Flags positions whose calculated health factor is below 1.0. It does not sign or submit transactions.

The public API provides market discovery, but its all-positions health endpoint is private and requires a Morpho API key. The public scanner therefore discovers borrowers from protocol events and verifies their current positions onchain.

## Run

Set `ETHEREUM_RPC_URL` to an Ethereum Mainnet RPC URL and keep it out of Git. The scanner shares `VAULTHUNTER_DB_PATH` with the Aave indexer, using separate Morpho tables.

```bash
npm install
npm run morpho:scan:once
npm run morpho:scan
```

The continuous command resumes from the global event checkpoint. It scans a bounded number of block ranges per pass, then rotates through markets and refreshes a limited batch of borrower positions. Keep it running with SQLite on persistent storage. A full historical scan can take a long time, depending on the RPC provider's log-range and rate limits.

## Configuration

- `MORPHO_MAX_MARKETS`: maximum Ethereum Blue markets discovered from the API (default 1000).
- `MORPHO_INDEXER_BATCH_BLOCKS`: blocks per log request (default 10; increase only if the RPC provider supports larger ranges).
- `MORPHO_INDEXER_MAX_BATCHES_PER_PASS`: maximum sequential log batches per pass (default 100).
- `MORPHO_CONFIRMATIONS`: blocks behind head used for event indexing (default 12).
- `MORPHO_MARKETS_TO_REFRESH_PER_PASS`: number of markets refreshed per pass (default 25).
- `MORPHO_SNAPSHOT_BATCH_SIZE`: borrower positions refreshed per selected market (default 10).
- `MORPHO_POLL_INTERVAL_MS`: wait after a completed pass (default 30 seconds).

## Important limitations

The first implementation is Ethereum Mainnet only. It uses the Morpho API for immutable market configuration and reads positions, market accounting and oracle prices from chain. Morpho market borrow assets accrue interest lazily; raw on-chain market totals may not include interest since the last accrual. Therefore this first health-factor result is a screening signal, not an authoritative liquidation quote. Before treating a position as executable, accrue interest with the Morpho SDK or an equivalent exact implementation, then re-read the position, market, and oracle at one pinned block and simulate the liquidation. Never use a stale API or SQLite snapshot to submit a transaction.

The scanner deliberately remains read-only. No private key, wallet, signing, transaction construction, or transaction submission is included.
