# Morpho Blue read-only adapter

The read-only adapter supports Morpho Blue on Base (8453) and Arbitrum (42161).
Deployment addresses are taken from the official Morpho contract-address registry:
https://docs.morpho.org/developers/contracts/addresses/

The adapter reads:
- immutable market parameters (loan token, collateral token, oracle, IRM, LLTV)
- aggregate market borrow assets and shares
- a supplied borrower's position
- the market oracle's 1e36-scaled price

It estimates borrow assets by rounding the borrow-share conversion upward and
checks the LLTV threshold. This is a candidate detector only. Before any real
liquidation, the position must be re-read at a pinned recent block and the
protocol's official liquidation call semantics, accrued interest and all token
decimals must be independently validated.

## Limitations
- This module does not discover every borrower. An event indexer must first
  collect borrowers from the Morpho contract's SupplyCollateral and Borrow events.
- The returned borrow amount is in loan-token base units; collateral amount is
  in collateral-token base units. Token decimals and oracle orientation must be
  applied by a separate valuation layer before calculating USD profit.
- No wallet, signer, approval, transaction submission, flash-loan or swap logic
  is present. The module is read-only.
- Do not treat `liquidationEligible` as an execution instruction.
