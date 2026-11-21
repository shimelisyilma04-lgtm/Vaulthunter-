# VaultHunter production release gates

**Current status: NOT APPROVED FOR MAINNET EXECUTION.** This document is a release checklist, not an audit report.

## 0. Current safety boundary

- The API and dashboard are read-only.
- Foundry fork tests mutate only local fork state.
- The isolated executor harness uses mocks and is test-only.
- No production executor contract is approved, deployed, or connected to a signer.
- No private key, wallet signing, transaction submission, or public mempool broadcasting is enabled.

## 1. Protocol correctness

- [x] Verify Aave Addresses Provider resolves the configured Pool proxy on Base and Arbitrum.
- [x] Read the EIP-1967 implementation slot and require non-empty implementation bytecode on both networks.
- [x] Verify Morpho Blue singleton bytecode on both networks.
- [x] Differentially compare Base Morpho accrued borrow assets against the deployed Morpho core's `accrueInterest` on a local fork.
- [ ] Run the same Morpho accrual differential on Arbitrum with a live market ID from Morpho's official API.
- [ ] Identify the deployed Aave implementation/source revision for each chain; do not infer it from a Pool revision getter.
- [ ] Differentially test Aave liquidation pair calculations against actual Pool execution on local forks using valid liquidatable borrower fixtures for both networks.
- [ ] Test eMode, reserve-specific close-factor thresholds, protocol fee, dust rules, collateral caps, token decimals and rounding for both deployments.
- [ ] Re-run deployment fingerprints after every proxy upgrade.

## 2. Complete transaction path

A production candidate must be written separately from the mock harness and must support only explicitly allowlisted assets, protocols, routers and chains.

- [ ] Aave `flashLoanSimple` -> authenticated `executeOperation` -> Pool `liquidationCall` -> approved swap -> exact premium repayment -> minimum retained profit.
- [ ] Morpho flash loan -> authenticated `onMorphoFlashLoan` -> Morpho `liquidate` -> authenticated `onMorphoLiquidate` -> approved swap -> loan-token repayment -> minimum retained profit.
- [ ] Verify callback caller, initiator, chain ID, active operation, market/borrower/assets/amounts, one-time callback state and deadline.
- [ ] Measure token balance deltas; do not trust router return values.
- [ ] Use exact, temporary approvals and clear approvals after use.
- [ ] Reject arbitrary targets, arbitrary calldata, delegatecall, unlisted routers, unlisted tokens, stale plans and mismatched quote blocks.
- [ ] Include Base L1 data fee / L2 fee treatment and chain-specific gas accounting.
- [ ] Ensure any failure reverts the entire transaction atomically.

## 3. Fork test coverage

- [ ] Configure valid, current Aave borrower fixtures and pass the transaction-level Base/Arbitrum tests (`AAVE_BASE_BORROWER`, `AAVE_BASE_COLLATERAL`, `AAVE_BASE_DEBT`, `AAVE_BASE_DEBT_TO_COVER`; corresponding `AAVE_ARBITRUM_*` variables).
- [ ] Configure valid, current Morpho borrower fixtures and pass the transaction-level Base/Arbitrum tests (`MORPHO_BASE_LIQUIDATION_MARKET_ID`, `MORPHO_BASE_LIQUIDATION_BORROWER`, `MORPHO_BASE_LIQUIDATION_REPAID_SHARES`; corresponding `MORPHO_ARBITRUM_*` variables).
- [ ] Run the same Morpho accrual differential on Arbitrum with `MORPHO_ARBITRUM_MARKET_ID` set to a live Blue market ID.
- [ ] Test exact collateral seized, debt repaid, protocol fee, flash-loan premium, swap output and final profit.
- [ ] Test stale quote, changed health factor, changed oracle price, insufficient liquidity, fee-on-transfer token, paused/frozen reserve, eMode mismatch, bad debt, callback replay, unauthorized callback, reentrancy, wrong chain, wrong market, wrong borrower, wrong token, excessive premium and failed swap.
- [ ] Fuzz amount boundaries and rounding; invariant-test no residual debt, no unexpected token loss, no lingering approvals, no unauthorized calls and no execution below minimum profit.
- [ ] Run tests on pinned fork blocks and preserve transaction traces as CI artifacts.

## 4. Independent security review

An external reviewer with Solidity and DeFi liquidation experience must receive:
- the exact production executor commit and compiler settings;
- threat model and trust assumptions;
- protocol integration specifications and deployed addresses;
- fork test suite, fuzz/invariant tests and traces;
- dependency and deployment configuration;
- emergency pause and upgrade/ownership model.

Required before release:
- [ ] Independent audit report with findings and severity.
- [ ] All critical/high findings fixed and independently retested.
- [ ] Publicly documented residual risks and accepted medium/low findings.
- [ ] Reproducible build and bytecode verification for the exact reviewed commit.
- [ ] Deployment rehearsal on testnet/fork, including pause and recovery procedures.

An internal code review, a green CI run, or this checklist does not substitute for an independent audit.

## 5. Controlled rollout — only after all prior gates

- [ ] Deploy only after an adult owner and qualified reviewer approve the deployment plan.
- [ ] Start with testnet/fork rehearsal; then a deliberately capped, low-value pilot only if legally and operationally appropriate.
- [ ] Enforce per-transaction, per-day and per-asset risk limits, allowlists, deadline, minimum profit and circuit breakers.
- [ ] Monitor inclusion cost, reverts, balance deltas, protocol upgrades and oracle/IRM anomalies.
- [ ] Keep a tested emergency pause and revoke/disable path.
- [ ] Do not store a seed phrase or private key in source code, CI, Render variables, logs or chat.

## Evidence currently available

- The Foundry local-fork run passed Base and Arbitrum Aave deployment identity checks: Addresses Provider -> Pool proxy, EIP-1967 implementation slot, non-empty implementation bytecode, and reserve list.
- The same run passed Base Morpho accrual differential: the three-term fixed-point result matched the deployed Morpho core's post-`accrueInterest` market total. Arbitrum Morpho accrual was skipped because a verified live market ID has not yet been configured.
- Direct `getRevision()` calls reverted on both Aave Pool proxies in the first fork attempt, so that getter is not used as a version signal.
- The Aave selected-reserve close-factor helper was corrected and unit tests were updated. Fork differential verification against valid borrowers is still outstanding.
- The mock executor harness has passed in earlier CI runs. It is not production executor code.


## Optional local-fork liquidation fixtures

The fork test contract includes opt-in tests that call the actual Aave Pool or Morpho Blue singleton on a local fork. They skip when the corresponding environment variables are absent. Aave fixtures must identify a borrower whose health factor is below 1 at the fork's current block, plus a valid collateral reserve, debt reserve and debt-to-cover amount. Morpho fixtures must identify a liquidatable borrower, market ID and positive repaid share amount. These tests do not submit transactions to the live networks; they mutate only Foundry's local fork. The current CI intentionally does not invent borrower fixtures, so these transaction-level cases remain unexecuted until verified fixtures are supplied.
