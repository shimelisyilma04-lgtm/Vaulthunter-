# VaultHunter network and protocol status

## Supported network IDs
- Ethereum: 1
- Base: 8453
- Arbitrum: 42161
- Scroll: 534352 (RPC health registry only; no Aave or Morpho adapter yet)

## Aave V3
- Ethereum: existing scanner and historical indexer.
- Base: read-only current borrower account-data check.
- Arbitrum: read-only current borrower account-data check.
- Base and Arbitrum borrower discovery/indexing is not implemented yet. Supply borrower addresses from a trusted indexer before calling the adapter.

## Morpho Blue
- Base: read-only market/position/oracle adapter.
- Arbitrum: read-only market/position/oracle adapter.
- Market IDs and borrower addresses must be supplied by an external event indexer. The adapter does not discover all positions.
- Stored market borrow totals are used for borrow-share conversion; accrued interest is not independently applied. Treat results as preliminary candidates only.

## Not implemented
- Multi-chain event indexers and durable checkpoints for Base/Arbitrum.
- Token-decimal-aware USD valuation and reliable DEX quotes.
- Conservative profitability ranking based on live swap quotes and gas.
- Fork simulation harnesses for Aave and Morpho.
- Dashboard API/UI integration for the new chains.
- Flash-loan executor, approvals, signing and transaction broadcasting.

## Safety
The project remains read-only. Execution is disabled and no wallet private keys are required.
