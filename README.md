# VaultHunter

VaultHunter is a read-only DeFi liquidation and keeper-intelligence project.

## Current implementation

- Ethereum JSON-RPC connectivity.
- Tested integer-based liquidation screening and profitability calculations.
- Aave V3 Ethereum bounded borrower scanner: reads recent Borrow events, resolves the Pool through the official addresses provider, and checks current account health directly against the Pool.
- No wallet, private key, transaction signing, or transaction submission.

## Run the Aave scanner

Requires Node.js 20+ and an Ethereum Mainnet RPC URL.

```bash
npm install
ETHEREUM_RPC_URL="https://YOUR_ETHEREUM_RPC_ENDPOINT" npm run aave:scan
```

Optional configuration: `AAVE_SCAN_LOOKBACK_BLOCKS` (1–10,000; default 2,000).

See [Aave scanner documentation](docs/AAVE_SCANNER.md) for the discovery window and limitations.

## Safety and scope

A recent Borrow-event scan is not a complete index of all Aave borrowers. It can miss accounts whose borrowing events occurred before the selected window. Current account health is queried after event discovery and may change immediately. A result is a candidate for further investigation, not proof that a liquidation transaction will succeed or be profitable.

Before any future execution capability, the system needs durable historical indexing, reorg-safe updates, exact on-chain eligibility checks, pinned-block simulation, conservative cost modelling, explicit risk limits, and independent security review. Execution is deliberately out of scope and disabled.

This experimental software is not financial advice. DeFi systems carry substantial risk, including total loss.
