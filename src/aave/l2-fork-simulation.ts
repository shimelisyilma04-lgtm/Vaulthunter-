import { Contract, JsonRpcProvider, Interface, getAddress } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "./l2-readonly.js";
import { simulateForkCall } from "./fork-simulation.js";

const PROVIDER_ABI = ["function getPool() view returns (address)"] as const;
const LIQUIDATION_INTERFACE = new Interface([
  "function liquidationCall(address collateralAsset,address debtAsset,address user,uint256 debtToCover,bool receiveAToken)"
]);

/**
 * Simulates a directly-funded Aave V3 Base/Arbitrum liquidation on a private
 * Anvil fork. It does not implement or imply a flash-loan callback.
 */
export async function simulateAaveL2DirectLiquidation(
  forkRpcUrl: string,
  input: {
    network: AaveL2Network;
    collateralAsset: string;
    debtAsset: string;
    borrower: string;
    debtToCover: string;
    receiveAToken: boolean;
    from: string;
  },
  confirmations = 1
) {
  const deployment = AAVE_V3_MARKETS[input.network];
  const collateralAsset = getAddress(input.collateralAsset);
  const debtAsset = getAddress(input.debtAsset);
  const borrower = getAddress(input.borrower);
  const from = getAddress(input.from);
  if (collateralAsset === debtAsset) throw new Error("Collateral and debt assets must differ");
  if (!/^[1-9][0-9]*$/.test(input.debtToCover) || input.debtToCover.length > 78) {
    throw new Error("debtToCover must be a positive integer string");
  }
  const provider = new JsonRpcProvider(forkRpcUrl, deployment.chainId, { staticNetwork: true });
  let pool: string;
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(deployment.chainId)) throw new Error("Aave fork chain ID mismatch");
    const addressesProvider = new Contract(deployment.addressesProvider, PROVIDER_ABI, provider);
    pool = getAddress(String(await addressesProvider.getFunction("getPool").staticCall()));
  } finally {
    await provider.destroy();
  }
  const data = LIQUIDATION_INTERFACE.encodeFunctionData("liquidationCall", [
    collateralAsset, debtAsset, borrower, BigInt(input.debtToCover), input.receiveAToken
  ]);
  const result = await simulateForkCall(forkRpcUrl, { to: pool, data, from }, confirmations, deployment.chainId);
  return {
    ...result,
    protocol: "aave-v3" as const,
    network: input.network,
    simulationType: "direct-funded-liquidation-call" as const,
    liquidation: { collateralAsset, debtAsset, borrower, debtToCover: input.debtToCover, receiveAToken },
    warning: "Direct-funded Aave Pool call only. The fork sender must hold and have approved the debt token. This does not test a flash-loan executor, callback, swap, repayment, or atomic end-to-end transaction."
  };
}
