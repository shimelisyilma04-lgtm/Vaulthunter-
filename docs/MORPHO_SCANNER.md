# Morpho Blue Ethereum scanner

## Data sources and coverage

- Discovers Morpho Blue market configuration through the public Morpho Core REST API: `GET https://api.morpho.org/v0/blue/markets?chain_id=1`.
- Reads borrower activity from the Ethereum Morpho Blue singleton's `Borrow`, `Repay`, `SupplyCollateral`, `WithdrawCollateral`, and `Liquidate` events.
- Persists per-market block checkpoints and borrower addresses in the shared SQLite database.
- Reads each discovered position, market totals, and oracle price from Ethereum RPC at a common observed block.
- Flags positions whose calculated health factor is below 1.0. It does not sign or submit transactions.

The public API is used for market discovery; it does not expose a public all-borrowers endpoint for Blue. Borrower discovery therefore uses the protocol's on-chain events. Morpho's private market-position-health endpoint exists, but requires a private API key and is not required by this scanner.

## Run

Set `ETHEREUM_RPC_URL` to an Ethereum Mainnet RPC URL and keep it out of Git. The scanner shares `VAULTHUNTER_DB_PATH` with the Aave indexer, using separate Morpho tables.

```bash
npm install
npm run morpho:scan:once
npm run morpho:scan
```

The continuous command resumes from stored per-market checkpoints. It starts at each market's creation block, indexes event logs in sequential ranges, then refreshes a rotating batch of borrower positions. A full discovery pass may take a long time because it examines historical events for every selected market. Keep the SQLite database on persistent storage and allow the process to run continuously.

## Configuration

- `MORPHO_MAX_MARKETS`: maximum Ethereum Blue markets discovered from the API (default 1000; API pages are cursor-paginated).
- `MORPHO_INDEXER_BATCH_BLOCKS`: blocks per log request (default 10; increase only if the RPC provider supports larger ranges).
- `MORPHO_CONFIRMATIONS`: blocks behind head used for event indexing (default 12).
- `MORPHO_SNAPSHOT_BATCH_SIZE`: borrowers refreshed per market per pass (default 100).
- `MORPHO_POLL_INTERVAL_MS`: wait after a completed pass (default 30 seconds).

## Important limitations

The first implementation is Ethereum Mainnet only. It uses the Morpho API for immutable market configuration and reads positions, market accounting and oracle prices from chain. Morpho market borrow assets accrue interest lazily; the raw on-chain market totals may not include interest since the last accrual. Therefore this first health-factor result is a screening signal, not an authoritative liquidation quote. Before treating a position as executable, accrue interest with the Morpho SDK or an equivalent exact implementation, then re-read the position, market, and oracle at one pinned block and simulate the liquidation. Never use a stale API or SQLite snapshot to submit a transaction.

The scanner deliberately remains read-only. No private key, wallet, signing, transaction construction, or transaction submission is included.
