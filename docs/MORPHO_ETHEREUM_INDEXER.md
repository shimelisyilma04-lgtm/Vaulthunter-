# Morpho Blue Ethereum indexer

## What it does

- Discovers Morpho Blue Ethereum markets from the public Morpho API.
- Indexes Borrow, Repay, SupplyCollateral, WithdrawCollateral and Liquidate events from the Morpho Blue contract.
- Stores discovered market/borrower state and a block-hash checkpoint in PostgreSQL when `DATABASE_URL` is configured.
- Verifies the saved checkpoint against the canonical chain and resets discovered borrowers if a reorganization invalidates the checkpoint.
- Refreshes borrower positions, market totals, oracle prices and IRM rate views at one pinned Ethereum block. Liquidator funding is deliberately left unverified.
- Accrues debt using Morpho's three-term Taylor compounding and virtual-share rounding.
- Produces a full-position diagnostic liquidation quote, including repayment and collateral seizure calculations. The scanner sets available liquidator funding to zero because no wallet or flash-loan source is integrated.
- Does not construct calldata, sign, broadcast or submit transactions.

## Enable it on Render

The service already supports PostgreSQL for Aave. The Morpho adapter uses the same `DATABASE_URL` but its own `morpho_*` tables.

1. Confirm `DATABASE_URL` is present in the Render service environment. Do not paste the value into GitHub, a log, or chat.
2. Confirm `ETHEREUM_RPC_URL` points to an Ethereum Mainnet RPC endpoint with archive/log access appropriate for the requested history.
3. Add `MORPHO_INDEXER_ENABLED=true`.
4. Keep the initial bounded defaults:
   - `MORPHO_MAX_MARKETS=1000`
   - `MORPHO_INDEXER_BATCH_BLOCKS=10`
   - `MORPHO_INDEXER_MAX_BATCHES_PER_PASS=100`
   - `MORPHO_CONFIRMATIONS=12`
   - `MORPHO_SNAPSHOT_BATCH_SIZE=10`
   - `MORPHO_MARKETS_TO_REFRESH_PER_PASS=25`
   - `MORPHO_POLL_INTERVAL_MS=30000`
5. Save the environment changes and let Render deploy/restart the service.
6. Check logs for:
   - `VaultHunter Morpho storage backend: PostgreSQL`
   - `Starting Morpho Blue Ethereum indexer in read-only mode`
   - `Morpho Blue indexer pass completed`

If you see the local SQLite storage warning in production, stop and check `DATABASE_URL`; the production Morpho factory refuses to start without it.

## Local commands

```bash
npm run morpho:index:once
npm run morpho:index
```

Both commands require `ETHEREUM_RPC_URL`. In production, the indexer also requires `DATABASE_URL`.

## Limits and interpretation

- The market discovery list is capped by `MORPHO_MAX_MARKETS`; event discovery scans the Morpho Blue contract's supported position events, but snapshot refresh only covers markets returned by the market API.
- Historical indexing begins at the earliest creation block among the discovered markets. It can require a very large number of `eth_getLogs` requests and may take many hours or days. Free RPC quotas may be insufficient.
- Borrower addresses are discovered from position events; this is not a guarantee that every historical borrower or every current market has been refreshed.
- The quote currently evaluates repayment of all indexed borrower borrow shares as a diagnostic upper-bound case. The scanner does not claim the liquidator has funding; its funding input is zero and the funding sufficiency flag remains false. The quote is not an optimal partial-liquidation size, not a DEX route, not net profit, and not an execution recommendation.
- The scanner's IRM `borrowRateView` accrual is a screening approximation that still requires parity testing against Morpho's stateful accrual path and protocol test vectors.
- Loan-token balance at Morpho is a market-level balance check, not proof that a specific liquidation callback, funding route, or swap can settle.
- No flash-loan callback, DEX execution route, transaction builder, signer or broadcaster is included.

A candidate is a reason to investigate further, not proof of executable or profitable liquidation. Use an isolated fork and independently reviewed transaction harness before any future execution milestone.
