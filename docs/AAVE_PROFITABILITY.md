# Aave V3 historical discovery and profitability

## Full historical borrower discovery

The Aave V3 indexer starts at the Ethereum Pool deployment block (16,291,127 by default), indexes Borrow events into SQLite, and persists a block-hash checkpoint after each batch. Run:

```bash
npm run aave:index
```

Keep the process running with a persistent `VAULTHUNTER_DB_PATH`. It resumes from the last confirmed block after restarts. The first full scan can take many hours or days on public/free RPC endpoints. The default log range is 10 blocks to suit restrictive providers. If your provider documents a larger `eth_getLogs` range, you may increase `AAVE_INDEXER_BATCH_BLOCKS` (maximum 2000) in `.env`. If the provider rejects that range, restore a smaller value. Do not parallelize requests to bypass rate limits.

When the event index reaches the confirmed head, the indexer rotates through stored borrowers and refreshes current Pool account data. Candidate health factors are monitoring signals and can change immediately.

## Profitability estimator

`src/aave/profitability.ts` estimates the value of collateral received from a proposed debt repayment using the reserve liquidation bonus, then subtracts estimated gas, swap, flash-loan, builder and safety-margin costs. Every input must be a conservative USD-WAD value. The helper is covered by unit tests.

This is an economic calculation component, not yet an end-to-end live profitability feed. A live quote still needs per-user debt and collateral reserve balances, reserve liquidation bonus and decimals, oracle prices, close-factor rules, collateral availability, exact swap quotes, gas simulation and any builder/flash-loan charges. Aggregate `getUserAccountData` totals are insufficient to calculate a specific liquidation. Do not label an account profitable until those reserve-level values are fetched and the exact liquidation is simulated at a pinned block.
