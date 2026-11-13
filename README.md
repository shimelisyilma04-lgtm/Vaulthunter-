# VaultHunter

VaultHunter is an open-source research and monitoring foundation for DeFi liquidation opportunities and incentivized vault-keeper tasks.

## Current status

**Milestone 1: read-only foundation.** This repository currently contains protocol-independent domain logic and configuration scaffolding. It does not submit transactions, custody funds, or promise profitable opportunities.

## Initial scope

- Liquidation monitoring, beginning with Aave V3 after its adapter is implemented against verified protocol interfaces.
- Morpho Blue market monitoring as a second integration.
- Keeper-task discovery only where an explicit, verifiable reward mechanism exists.
- Conservative opportunity evaluation that accounts for debt repayment, swap costs, gas, flash-loan fees, builder fees, and a safety margin.

## Safety model

- Read-only monitoring by default.
- Execution is disabled unless a future, separately reviewed release explicitly enables it.
- Never commit private keys, seed phrases, API secrets, or production RPC credentials.
- A positive estimated spread is not proof of an executable or profitable transaction. Simulate against a pinned block and account for competition and changing state.
- Use integer base units for token amounts; do not use JavaScript floating-point arithmetic for on-chain quantities.

## Requirements

- Node.js 20+
- npm 10+

## Local development

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

The current app is a small read-only domain foundation. Protocol RPC adapters, fork simulation, keeper integrations, and any transaction execution are future milestones.

## Planned milestones

1. Read-only foundation, typed configuration, and tested domain calculations.
2. Verified Aave V3 and Morpho Blue data adapters.
3. Liquidation and explicitly incentivized keeper-task discovery.
4. Profitability engine with conservative cost assumptions.
5. Fork-based simulation and risk controls.
6. Independent security review before considering any execution capability.

## Disclaimer

This is experimental software, not financial advice. DeFi protocols, smart contracts, oracles, and transaction execution carry substantial risks, including total loss. Do not fund or deploy an executor based solely on estimates from this software.
