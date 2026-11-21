# Liquidation candidate validation gates

VaultHunter is a read-only research and monitoring tool. The validation module
(`src/domain/validation.ts`) implements conservative evidence gates for future
protocol quote and simulation adapters. It does not sign, construct, or submit
transactions and cannot authorize execution.

## Required evidence

A candidate must use one pinned block for all of the following:

- borrower/position accounting, including exact accrued interest where applicable;
- protocol-specific liquidation constraints and incentive/bonus calculations;
- oracle price and collateral/debt token decimals;
- available debt and collateral liquidity;
- executable swap quote and conservative gas estimate;
- successful transaction simulation against that same block;
- net-profit estimate above a configured minimum.

A missing evidence item returns `needs_data`. A stale snapshot, mismatched block,
failed/reverted simulation, wrong chain, or insufficient net-profit threshold
returns `rejected`. Only complete evidence can reach `simulation_review`.

## Important protocol-specific work still required

### Morpho Blue

Morpho's raw `market()` values represent the last interest-accrual state, not
necessarily the current debt. Use the official Morpho SDK / MorphoBalancesLib
or an exact implementation of the Morpho interest accrual path, including the
market's IRM, `lastUpdate`, Taylor-compounded interest and rounding. Calculate
borrower debt shares against the accrued totals. Then calculate the liquidation
incentive and repay/seize amounts with the same rounding rules as the contract.
Do not use the current scanner's raw totalBorrowAssets as an authoritative quote.

### Aave V3

Aggregate `getUserAccountData` is not a liquidation quote. Fetch each relevant
collateral and debt reserve, user aToken/debt-token balances, reserve decimals,
liquidation bonus/threshold, eMode/isolation and protocol liquidation constraints.
Use the current Aave implementation and simulate the exact `liquidationCall`
at a pinned block. Handle protocol-specific fees and close-factor rules.

## What a passing status means

`simulation_review` means only that the evidence supplied to this validator
passed these software checks. It is not a profitability guarantee, security
audit, financial recommendation, or authorization to send a transaction.
External RPC data, DEX liquidity, mempool ordering, gas, oracle prices and
contract state can change. Independent review and extensive fork testing remain
necessary. Real-money execution is intentionally out of scope for this project.
