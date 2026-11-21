import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import { MORPHO_BLUE_ADDRESSES, type MorphoNetwork } from "./blue.js";
import { simulateForkCall } from "../aave/fork-simulation.js";

const MARKET_ABI = [
  "function idToMarketParams(bytes32 id) view returns (tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))"
] as const;
const LIQUIDATE_INTERFACE = new Interface([
  "function liquidate((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,bytes data)"
]);

/**
 * Simulates a directly-funded Morpho Blue liquidation on a private Anvil fork.
 * Empty callback data uses Morpho's direct transferFrom path; no flash loan.
 */
export async function simulateMorphoBlueDirectLiquidation(
  forkRpcUrl: string,
  input: {
    network: MorphoNetwork;
    marketId: string;
    borrower: string;
    seizedAssets?: string;
    repaidShares?: string;
    from: string;
  },
  confirmations = 1
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.marketId)) throw new Error("marketId must be bytes32");
  const seizedAssets = input.seizedAssets ?? "0";
  const repaidShares = input.repaidShares ?? "0";
  const validAmount = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78;
  if (!validAmount(seizedAssets) || !validAmount(repaidShares)) throw new Error("Liquidation amounts must be unsigned integer strings");
  if ((BigInt(seizedAssets) > 0n) === (BigInt(repaidShares) > 0n)) {
    throw new Error("Set exactly one of seizedAssets or repaidShares to a positive amount");
  }
  const borrower = getAddress(input.borrower);
  const from = getAddress(input.from);
  const chainId = input.network === "base" ? 8453 : 42161;
  const morphoAddress = MORPHO_BLUE_ADDRESSES[input.network];
  const provider = new JsonRpcProvider(forkRpcUrl, chainId, { staticNetwork: true });
  let marketParams: readonly unknown[];
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(chainId)) throw new Error("Morpho fork chain ID mismatch");
    const morpho = new Contract(morphoAddress, MARKET_ABI, provider);
    marketParams = await morpho.getFunction("idToMarketParams").staticCall(input.marketId) as readonly unknown[];
  } finally {
    await provider.destroy();
  }
  const data = LIQUIDATE_INTERFACE.encodeFunctionData("liquidate", [
    {
      loanToken: getAddress(String(marketParams[0])),
      collateralToken: getAddress(String(marketParams[1])),
      oracle: getAddress(String(marketParams[2])),
      irm: getAddress(String(marketParams[3])),
      lltv: BigInt(String(marketParams[4]))
    },
    borrower, BigInt(seizedAssets), BigInt(repaidShares), "0x"
  ]);
  const result = await simulateForkCall(forkRpcUrl, { to: morphoAddress, data, from }, confirmations, chainId);
  return {
    ...result,
    protocol: "morpho-blue" as const,
    network: input.network,
    simulationType: "direct-funded-liquidation-call" as const,
    marketId: input.marketId,
    borrower,
    seizedAssets,
    repaidShares,
    warning: "Direct-funded Morpho Blue liquidation only. The fork sender must hold and have approved the loan token. This does not test a flash-loan executor, callback, swap, repayment, or atomic end-to-end transaction."
  };
}
