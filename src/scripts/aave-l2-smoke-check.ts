import { inspectAaveL2ReservePositions } from "../aave/l2-reserve-positions.js";

const borrower = "0x0000000000000000000000000000000000000001";
const networks = [
  { network: "base" as const, rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org" },
  { network: "arbitrum" as const, rpcUrl: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc" }
];
const results = [];
for (const item of networks) {
  const snapshot = await inspectAaveL2ReservePositions({
    network: item.network,
    rpcUrl: item.rpcUrl,
    borrower,
    confirmations: 0
  });
  results.push({
    network: snapshot.network,
    chainId: snapshot.chainId,
    blockNumber: snapshot.observedBlock,
    pool: snapshot.pool,
    reserveCount: snapshot.reserves.length,
    pairCount: snapshot.pairs.length,
    userEModeCategory: snapshot.userEModeCategory,
    eModeProfile: snapshot.eModeCategory?.profile ?? "none",
    flashLoanPremiumBps: snapshot.flashLoanPremiumBps,
    minBaseMaxCloseFactorThreshold: snapshot.minBaseMaxCloseFactorThreshold,
    minLeftoverBase: snapshot.minLeftoverBase,
    warnings: snapshot.warnings
  });
}
process.stdout.write(JSON.stringify({
  status: "aave-l2-read-only-adapters-verified",
  borrower: "synthetic-zero-position-smoke-check",
  note: "This verifies deployed read ABIs and reserve reads only; it does not validate liquidation math against a liquidatable account.",
  results
}, null, 2) + "\n");
