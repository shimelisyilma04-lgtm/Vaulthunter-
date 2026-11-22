# Morpho + Aave flash-loan fork executor (experimental)

This is an **unaudited research prototype**, not production liquidation software.

## Safety boundary

- The Solidity constructor and every execution entry point require `block.chainid == 31337`.
- Deploy only to a local Anvil Ethereum-mainnet fork started with `--chain-id 31337`.
- Do not deploy this contract to Ethereum mainnet or any public network.
- The application must continue to keep transaction signing and submission disabled.
- A successful simulation is not evidence of profitability in live conditions.

## Atomic flow

1. Anvil-fork caller invokes `simulate(plan, flashAmount)`.
2. The executor requests Aave V3 `flashLoanSimple` for the Morpho market loan token.
3. Aave calls `executeOperation`; the callback verifies the Aave pool and initiator.
4. The executor approves and calls Morpho Blue `liquidate` with the supplied market parameters, borrower and liquidation sizing.
5. It sends the actual seized collateral through the supplied packed Uniswap V3 exact-input path.
6. The router's minimum output is set to flash principal + Aave premium + `minProfit`. A revert atomically rejects an underfunded or unprofitable result.
7. The executor approves Aave to collect principal plus premium.

The caller must provide a correctly encoded V3 path whose first token is the collateral token and last token is the loan token. Intermediate tokens and fee tiers are supplied by the caller.

## Tests

The dependency-free Solidity tests in `test/MorphoAaveFlashloanForkExecutor.t.sol` exercise callback wiring, path validation, and rejection when swap output is below flash principal + premium + minimum profit. They use mocks; **they are unit tests, not a real-protocol fork integration test**.

Run with Foundry:
```sh
forge test
```

## Still required before a real fork integration test

- Compile and review the contract with a pinned Solidity toolchain.
- Run against an isolated Anvil fork at a pinned block, with the real Morpho Blue, Aave V3 Pool, and Uniswap V3 SwapRouter deployments.
- Supply a real, freshly validated borrower/market plan and a viable route.
- The API converts estimated ETH gas cost to the loan-token denomination using a WETH-to-loan-token Uniswap V3 quote at the exact pinned fork block. If no valid route exists, net profit in loan-token units remains null.
- Independently audit the executor and test adversarial token/route behavior before considering any use beyond local simulation.

No transaction signing, broadcasting, or mainnet execution is implemented or enabled by this contract.
