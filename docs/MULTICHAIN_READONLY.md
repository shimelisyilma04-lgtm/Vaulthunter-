# Multi-chain read-only foundation

VaultHunter now has a network registry for Ethereum, Base, Arbitrum and Scroll.
The first expansion target is Base + Arbitrum, with Scroll kept optional. Network
support is not the same as verified protocol-market support.

## Configure RPC endpoints

Set any endpoints you have access to in the environment. Do not commit credentials.

```dotenv
ETHEREUM_RPC_URL=
BASE_RPC_URL=
ARBITRUM_RPC_URL=
SCROLL_RPC_URL=
```

Run the read-only network probe with:

```bash
npm run chains:check
```

The probe checks `eth_chainId` and `eth_blockNumber`, verifies the returned
chain ID against the expected ID, and reports unavailable or mismatched endpoints.
It does not sign, simulate, or broadcast transactions.

## Protocol rollout

1. Keep the existing Ethereum Aave indexer unchanged.
2. Add separate Aave V3 deployment metadata and tests for Base and Arbitrum.
3. Add Morpho Blue as a separate adapter; do not reuse Aave liquidation logic.
4. Discover Morpho markets from the official registry and validate chain-specific
   contract addresses before querying them.
5. Add pinned-block position reads and historical event indexing.
6. Add fork-based simulation and conservative cost estimation as a separate
   milestone.

## Safety boundary

This milestone is read-only. No private keys, wallet signing, flash-loan execution,
liquidation transaction submission, or autonomous mainnet trading are included.
A detected health factor or Morpho liquidation condition is only a candidate:
it must be rechecked against current chain state and protocol-specific rules.
