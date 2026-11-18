# Liquidation math and validation boundaries

This document describes screening math only. It is not transaction construction, execution authorization, or financial advice.

## Aave V3

Aave V3's documented close-factor rules are:

- Up to 50% of total debt when health factor is above 0.95 and both selected collateral and debt positions are at least 2,000 base-currency units.
- Up to 100% when health factor is at or below 0.95, or either selected position is below 2,000 base-currency units.
- A partial liquidation must leave at least 1,000 base-currency units of both debt and collateral remaining.

The current Aave estimate is deliberately conservative. It caps repayment by the close-factor ceiling, selected debt balance, and collateral available after the liquidation bonus. It rejects estimates that would violate the residual-balance check. Reserve-specific bonus, protocol fee, eMode treatment, and oracle values must come from the same market snapshot. Custom eMode price-source overrides are not supported by the existing adapter.

Sources:
- https://aave.com/faq
- https://aave.com/docs/aave-v3/smart-contracts/pool

## Morpho Blue

The pure TypeScript estimator mirrors the Morpho Blue core liquidation math for a caller-selected borrow-share repayment:

- Health check: `maxBorrow = floor(floor(collateralAssets * oraclePrice / 1e36) * LLTV / 1e18)`; a position is unhealthy when this is below the borrow assets converted with upward rounding.
- Liquidation incentive factor: `min(1.15e18, floor(1e36 / (1e18 - floor(0.3e18 * (1e18 - LLTV) / 1e18))) )`.
- Collateral seizure follows the core contract's rounding: borrow shares to assets down, multiply by LIF down, then convert loan value to collateral units down.
- Actual loan assets repaid are converted from shares with upward rounding.

Morpho Blue does not use a fixed close factor. The requested repayment share amount determines the partial or full repayment. If computed collateral seizure exceeds the borrower's collateral, the estimate is rejected as not collateral-sufficient.

**Important integration boundary:** Morpho accrues interest inside its state-changing liquidation path. The current read-only position inspector exposes stored market totals and does not simulate interest accrual. Therefore the Morpho calculator is not wired into live opportunity ranking. Its market totals must be accrued and pinned to the exact simulation block before the result can be trusted even as a screening estimate.

Costs supplied to the Morpho calculator must all be denominated in loan-token base units. It does not convert token decimals to USD or prove that a DEX route, flash liquidity, callback, or transaction will succeed.

Sources:
- https://docs.morpho.org/developers/blue/concepts/liquidation/
- https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol

## What still blocks an executable liquidation

1. Accrued, pinned-block reserve/market state and exact debt/collateral conversions.
2. A complete route quote that converts seized collateral to the repayment asset, including token decimals, route liquidity, fees and slippage.
3. Flash-loan provider fee and availability, conservative gas-price conversion, builder/MEV budget, and a safety margin in one denomination.
4. Full transaction-level fork simulation using a separately audited executor and callback path.
5. Independent smart-contract security review and operational risk controls.

VaultHunter remains read-only. It does not hold keys, sign transactions, deploy an executor, or broadcast transactions.
