# Architecture and delivery principles

## Operating modes

1. **Monitor** — reads chain state and emits candidate observations.
2. **Simulate** — evaluates a candidate against a pinned block or local fork.
3. **Execute** — intentionally out of scope for the current milestone and must remain disabled until separately reviewed.

## Planned components

- Chain connectors: typed RPC clients, chain metadata, block pinning, retry/rate-limit policy.
- Protocol adapters: isolated Aave V3 and Morpho Blue readers built from verified official interfaces.
- Liquidation engine: protocol-specific eligibility checks and candidate normalization.
- Keeper engine: discovers tasks only when a documented reward or incentive exists.
- Profitability engine: denomination-aware cost accounting with conservative buffers.
- Simulation engine: fork-based transaction simulation and revert diagnostics.
- Execution coordinator: future, separately gated transaction submission with limits, pause controls, and monitoring.

## Data flow

Chain state -> protocol adapter -> normalized observation -> eligibility checks -> cost model -> simulation -> human-reviewed report.

Every observation should retain chain ID, block number, protocol/market identity, and observation timestamp. Do not combine values from different blocks without explicitly accounting for state drift.

## Profitability requirements

A candidate is not attractive merely because collateral value exceeds debt value. Account for debt repayment, swap fees and slippage, gas, flash-loan fees, builder or priority costs, protocol-specific bonuses/penalties, and a safety margin. Use integer base units and explicit token/price denomination metadata.

## Security boundaries

- No private keys or seed phrases in source control, logs, or chat.
- No live transaction signing in the read-only milestone.
- RPC endpoints are untrusted inputs; validate chain identity.
- Apply timeouts, rate limits, bounded retries, and stale-data checks.
- Require fork simulation and independent review before any future execution release.
- Treat keeper incentives as unverified until supported by official protocol documentation or contract state.
