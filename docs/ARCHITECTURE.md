# Architecture and delivery principles

## Operating modes

1. **Monitor** — reads chain state and emits candidate observations.
2. **Simulate** — evaluates a candidate against a pinned block or local fork.
3. **Execute** — intentionally out of scope for the current milestone and must remain disabled until separately reviewed.

## Components

- Chain connectors: typed RPC clients, chain metadata, block pinning, retry/rate-limit policy.
- Protocol adapters: isolated Aave V3 and future Morpho Blue readers built from verified official interfaces.
- Historical indexer: incremental event ingestion, durable checkpoints, confirmation-depth reorg recovery, and borrower aggregates.
- Storage: SQLite for the single-writer low-cost deployment; use a persistent volume and backups.
- Liquidation engine: protocol-specific eligibility checks and candidate normalization.
- Keeper engine: discovers tasks only when a documented reward or incentive exists.
- Profitability engine: denomination-aware cost accounting with conservative buffers.
- Simulation engine: fork-based transaction simulation and revert diagnostics.
- Execution coordinator: future, separately gated transaction submission with limits, pause controls, and monitoring.

## Aave market data flow

```text
Ethereum RPC
  -> Aave V3 Pool Borrow logs
  -> incremental confirmation-aware indexer
  -> SQLite event ledger + block-hash checkpoint
  -> borrower aggregate table
  -> current health-factor snapshots
  -> candidate feed for profitability analysis
```

The indexer processes sequential bounded block ranges. Each event batch and checkpoint are committed atomically. Before continuing, the last checkpoint block hash is compared with the canonical chain. On mismatch, the indexer rewinds by the configured confirmation depth and rebuilds borrower aggregates from retained events.

A full historical backfill is deliberately rate-limited. On free RPC tiers it may take a long time. SQLite is suitable for one active writer; horizontally scaled workers require a server database and a single-writer/lease mechanism.

## Profitability requirements

A candidate is not attractive merely because collateral value exceeds debt value. Account for debt repayment, swap fees and slippage, gas, flash-loan fees, builder or priority costs, protocol-specific bonuses/penalties, and a safety margin. Use integer base units and explicit token/price denomination metadata.

## Security boundaries

- No private keys or seed phrases in source control, logs, or chat.
- No live transaction signing in the read-only milestone.
- RPC endpoints are untrusted inputs; validate chain identity.
- Apply timeouts, rate limits, bounded retries, and stale-data checks.
- Require fork simulation and independent review before any future execution release.
- Treat keeper incentives as unverified until supported by official protocol documentation or contract state.
