# Base, Arbitrum and Morpho event discovery

VaultHunter exposes a bounded, read-only recent-event discovery endpoint:

`GET /api/v1/discovery/multichain?network=base&lookbackBlocks=10000`

Supported network values are `base` and `arbitrum`. The service uses
`BASE_RPC_URL` or `ARBITRUM_RPC_URL` respectively and checks the RPC chain ID
before querying logs.

The response includes:
- Aave V3 borrowers seen in recent Pool Borrow events (the indexed
  `onBehalfOf` address), with the Aave Pool resolved from the official
  Addresses Provider.
- Morpho Blue market IDs seen in CreateMarket, Borrow and SupplyCollateral
  events, plus position owners seen in Borrow and SupplyCollateral events.

The scan is deliberately bounded to at most 100,000 recent blocks, queried in
2,000-block chunks, and capped at 2,000 distinct borrower and market IDs.
It is not exhaustive historical discovery. Persist discoveries and scan
overlapping windows to build durable coverage; refresh every account and
market from current contract state before risk ranking.

This endpoint does not calculate liquidation eligibility or profitability,
does not obtain DEX quotes, and never signs or broadcasts transactions.
