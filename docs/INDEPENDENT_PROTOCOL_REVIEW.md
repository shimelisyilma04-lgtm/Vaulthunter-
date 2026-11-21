# Independent Protocol Review and Executor Test Plan

**Scope:** read-only Aave V3 on Base/Arbitrum and Morpho Blue on Base/Arbitrum. This is a source-level review and test plan, not a security audit or deployment approval.

## 1. Morpho Blue — source-level findings

Primary references:
- Core liquidation and accrual: https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol
- Core fixed-point math: https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/MathLib.sol
- Morpho's own liquidation bot state-lens description: https://github.com/morpho-org/morpho-bots/tree/main/bots/blue-liquidation
- Morpho IRM interface/implementations: https://github.com/morpho-org/morpho-blue-irm

Verified source rules:
1. Morpho's core `_accrueInterest` calls the market IRM's `borrowRate`, then computes `interest = totalBorrowAssets.wMulDown(borrowRate.wTaylorCompounded(elapsed))`.
2. The read-only mirror must use the IRM's `borrowRateView` at the same block, not the stateful `borrowRate` selector. Stateful adaptive IRMs may update their stored rate in `borrowRate`.
3. The current Morpho core `wTaylorCompounded` implementation uses **three terms**: `x + x²/2 + x³/6`, with fixed-point floor rounding at each intermediate step. A five-term exponential approximation is not core-equivalent.
4. Morpho share conversions use virtual assets = 1 and virtual shares = 1e6. Borrower debt is `toAssetsUp(borrowShares, accruedTotalBorrowAssets, totalBorrowShares)`; seizure sizing uses `toAssetsDown`.
5. Health is checked using `collateral.mulDivDown(price, 1e36).wMulDown(LLTV)` against debt rounded up.
6. Liquidation uses `LIF = min(1.15e18, WAD.wDivDown(WAD - 0.3e18.wMulDown(WAD - LLTV)))`. Morpho has no fixed close factor.
7. Core liquidation order is important: accrue interest; check health; calculate liquidation amounts; update market/position state; transfer collateral to the liquidator; invoke `onMorphoLiquidate` if callback data is non-empty; then pull loan-token repayment using `transferFrom`.

Changes made in this branch:
- The read path now calls `borrowRateView`.
- Taylor compounding now mirrors Morpho's three-term fixed-point sequence.
- Morpho borrow-share-to-asset conversion now includes virtual assets/shares.
- The pure liquidation estimate uses the same virtual-offset conversion in debt, repayment and seizure calculations.
- Tests cover the Taylor truncation and virtual-share conversion.

Remaining verification:
- A Base and Arbitrum fork differential test must compare the off-chain snapshot against Morpho's own `accrueInterest` / state on an isolated fork at the same timestamp and compare liquidation return values. This branch does not yet contain that full chain-state differential test.
- The exact deployed Morpho singleton address and runtime bytecode must be checked at a pinned block on each chain before any execution use.
- Market oracle and IRM behavior are external dependencies; a revert or invalid rate/price must invalidate that market rather than produce an estimate.

## 2. Aave V3 — source-level findings

Primary references:
- Current Aave V3 Origin liquidation logic: https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/LiquidationLogic.sol
- Aave V3.3 close-factor changes: https://github.com/aave-dao/aave-v3-origin/blob/main/docs/3.3/Aave-v3.3-features.md
- Aave liquidation rounding changes: https://github.com/aave-dao/aave-v3-origin/blob/main/docs/3.7/liquidation-rounding.md
- Aave Pool liquidation API: https://aave.com/docs/aave-v3/smart-contracts/pool
- Aave flash-loan flow: https://aave.com/docs/aave-v3/guides/flash-loans

Verified source rules:
1. The V3.3+ 50% close-factor condition is evaluated against the **selected debt reserve's debt value and selected collateral reserve's collateral value**, each compared with `MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD`, plus the health-factor threshold. It is not simply `totalDebtBase > threshold`.
2. When the condition applies, the 50% cap is half the user's **total account debt in base currency**, but it only caps the selected debt reserve when that reserve debt exceeds the cap.
3. Current Aave Origin uses eMode collateral bitmaps to select the category liquidation bonus. In its liquidation pair calculation it obtains collateral and debt prices from the ordinary reserve oracle; eMode-adjusted account health is calculated separately by GenericLogic. The older legacy eMode ABI exposed a priceSource and is handled as a separate compatibility profile, never conflated with the bitmap profile.
4. Current Aave Origin liquidation arithmetic uses floor for max-collateral multiplication, ceil for debt amount division when collateral is capped, and ceil for the protocol fee. The close-factor half-debt calculation uses PercentageMath half-up rounding. Bonus-collateral calculation uses floor division.
5. The dust guard is evaluated only when the liquidation leaves both debt and collateral. Both remaining values must be at least `MIN_LEFTOVER_BASE`; collateral remaining is calculated after the gross collateral consumption (liquidator amount plus protocol fee).
6. Aave `flashLoanSimple` transfers the asset, calls `executeOperation`, then pulls amount plus premium. The receiver must verify the caller/initiator and approve the Pool for the exact repayment plus fee.

Changes made in this branch:
- Close-factor helper now checks the selected reserve debt and collateral base values, and returns no sizing when the Pool's minimum threshold cannot be read.
- eMode now supports the current collateral-bitmap ABI and a separate legacy price-source ABI.
- Liquidation bonus/protocol fee arithmetic now follows the explicit floor/floor/ceil rounding profile in the current Origin 3.7 source.
- Deterministic unit tests cover the reserve-specific threshold and eMode cases, as well as rounding directions.

**Critical chain-version limitation:** the Base and Arbitrum addresses provider constants identify the starting points for reads, but this review has not independently resolved each live Pool proxy's implementation address, implementation runtime bytecode hash, or deployed revision. Aave has version-dependent liquidation logic. Therefore the Origin 3.7 arithmetic is a source-matched candidate, not a claim that both live L2 deployments currently run that exact revision. The ranking must remain screening-only until a fork differential test confirms the actual deployed implementation on each chain.

## 3. Swap and profitability assumptions

Primary reference: https://developers.uniswap.org/docs/sdks/v3/guides/swapping/quoting

A Quoter result is a simulated quote, not an execution guarantee. The current VaultHunter path is direct-pool only, and the gas-unit budget is supplied by the caller rather than measured from the complete executor. Before an opportunity may be considered executable, the isolated test must cover the actual route calldata and verify:
- token-in/token-out and recipient are exactly the approved plan values;
- the quote is tied to the same pinned block as the protocol snapshot;
- a hard `amountOutMinimum` is enforced by the router call;
- router output is measured from the executor's balance delta, not trusted from a return value;
- no unlisted token approvals or arbitrary call targets are permitted;
- the final balance covers repayment, premium, gas/MEV/safety budgets and a minimum profit.

MEV and builder amounts are budgets/assumptions, not guarantees that a private transaction will avoid competition or inclusion costs.

## 4. Isolated executor test architecture

The new Foundry suite is intentionally **test-only** under `test-solidity/`. It must never be imported by production code or deployed. It uses local mock ERC-20s, mock Aave Pool, mock Morpho, and mock swap router to test callback sequencing and atomic rollback without private keys or public RPCs.

Required invariants:
- only the configured protocol contract may invoke its callback;
- Aave callback initiator must be the executor itself;
- active plan, chain/protocol, debt token, collateral token, borrower, amount and market must match exactly;
- callback state is one-shot and protected against reentrancy;
- swap target and tokens are allowlisted, with strict minimum output;
- repayment allowance is exact and reset after repayment where supported;
- after liquidation and swap, debt-token balance must cover principal + premium/repayment + minimum profit over the pre-loan baseline;
- any failure reverts the complete mock transaction, including liquidation and swap token movements;
- Morpho's nested liquidation callback must finish with enough loan token for Morpho to pull repayment before the outer flash-loan callback repays the flash loan;
- tests include wrong caller, wrong initiator, wrong asset, wrong amount, excessive premium, insufficient output, insufficient repayment, reentrancy, and atomic rollback.

The harness validates architecture and callback assumptions only. It is not the production executor and cannot substitute for protocol fork tests, external review, formal verification, or a professional smart-contract audit.

## 5. Automated deployment fingerprint

`npm run verify:protocol-deployments` checks the official Aave PoolAddressesProvider → Pool proxy resolution, the EIP-1967 implementation slot, non-empty proxy/implementation bytecode and runtime code hashes at a pinned block on Base and Arbitrum. It also fingerprints the Morpho Blue singleton bytecode on both chains and detects the current bitmap versus legacy eMode ABI profile. GitHub CI runs this with public RPC fallbacks or the repository's optional RPC secrets.

A successful fingerprint proves which addresses and bytecode were observed at that block; it does **not** prove that the bytecode matches a verified source build or that the off-chain liquidation arithmetic is equivalent. Record the emitted implementation hashes, compare them to verified explorer/source builds, and run the fork differential suite before treating the corresponding protocol profile as verified.

## 6. Gate before any real execution

Do not enable signing, broadcasting, or an execution switch until all of the following are complete:
1. Base and Arbitrum deployed Pool implementation addresses and bytecode hashes are recorded at pinned blocks.
2. Aave fork tests compare reserve-level liquidation estimates with actual Pool behavior for both chains and supported eMode cases.
3. Morpho fork tests compare accrued market balances, borrower debt, health, LIF and liquidation return values against the actual singleton on both chains.
4. The complete executor path passes fork tests with realistic token behavior and router contracts, including revert/rollback and adversarial callback cases.
5. Gas is measured from the complete transaction on each chain, including Base L1 data fees.
6. An independent smart-contract security reviewer reviews the production executor and callback code; a separate audit is completed before meaningful funds are exposed.
7. A human operator verifies the plan and limits on a fresh block. No automatic execution is enabled by these tests.
