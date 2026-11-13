# Aave V3 Ethereum read-only scanner

## What it does

- Verifies Ethereum Mainnet (chain ID 1).
- Resolves the current Pool proxy through the official PoolAddressesProvider.
- Reads recent Pool Borrow logs in a bounded block window.
- Extracts borrower addresses from the event's `onBehalfOf` field.
- Reads each discovered account's current `getUserAccountData` directly from the Pool.
- Reports accounts with nonzero debt and a positive health factor below 1.

## Run

Set `ETHEREUM_RPC_URL` in the environment, then run:

```bash
npm install
npm run aave:scan
```

Optional: set `AAVE_SCAN_LOOKBACK_BLOCKS` (1–10,000; default 100).

## Important limitations

This is a bounded recent-event scanner, not a complete borrower index. It only discovers borrowers whose Borrow event appears in the selected block window. A production discovery service needs a durable historical event indexer, reorg handling, pagination, rate-limit-aware backfill, and continuous incremental updates. Log requests are split into 10-block ranges, serialized, and retried with backoff to accommodate restrictive RPC tiers.

Account data is read at the current latest block after event discovery, so the event window and account snapshot are not a single atomic block snapshot. A candidate is only a monitoring signal. Before any liquidation, re-read account data at a pinned block, verify reserve configuration and close-factor rules, simulate the exact transaction, and account for gas, slippage, liquidity, and competition.

The scanner does not construct or submit transactions. Execution remains disabled.
