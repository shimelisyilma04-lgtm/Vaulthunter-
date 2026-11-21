import { Contract, JsonRpcProvider, getAddress } from "ethers";

const PROVIDER_ABI = ["function getPool() view returns (address)"] as const;
const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)"
] as const;

export const AAVE_V3_MARKETS = {
  base: {
    chainId: 8453,
    addressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    expectedPool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"
  },
  arbitrum: {
    chainId: 42161,
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    expectedPool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
  }
} as const;

export type AaveL2Network = keyof typeof AAVE_V3_MARKETS;

export interface AaveL2BorrowerSnapshot {
  protocol: "aave-v3";
  network: AaveL2Network;
  chainId: 8453 | 42161;
  pool: string;
  borrower: string;
  observedBlock: number;
  totalCollateralBase: string;
  totalDebtBase: string;
  healthFactorWad: string;
  liquidationEligible: boolean;
}

/**
 * Read-only current-state check for a supplied borrower address.
 * Discovery/indexing is deliberately separate: callers must provide borrowers
 * found from a complete event index or trusted market data source.
 */
export async function inspectAaveL2Borrower(args: {
  network: AaveL2Network;
  rpcUrl: string;
  borrower: string;
}): Promise<AaveL2BorrowerSnapshot> {
  const market = AAVE_V3_MARKETS[args.network];
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(market.chainId)) {
      throw new Error(`Expected chain ${market.chainId}; received ${chain.chainId}`);
    }
    const addressesProvider = new Contract(market.addressesProvider, PROVIDER_ABI, provider);
    const poolAddress = getAddress(await addressesProvider.getFunction("getPool")() as string);
    if (poolAddress !== getAddress(market.expectedPool)) throw new Error("Aave Pool proxy does not match the pinned official deployment address for " + args.network + ".");
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const observedBlock = await provider.getBlockNumber();
    const account = await pool.getFunction("getUserAccountData")(
      getAddress(args.borrower), { blockTag: observedBlock }
    ) as readonly bigint[];

    const collateral = account[0];
    const debt = account[1];
    const healthFactor = account[5];
    if (collateral === undefined || debt === undefined || healthFactor === undefined) {
      throw new Error("Aave Pool returned incomplete account data");
    }
    return {
      protocol: "aave-v3",
      network: args.network,
      chainId: market.chainId,
      pool: poolAddress,
      borrower: getAddress(args.borrower),
      observedBlock,
      totalCollateralBase: collateral.toString(),
      totalDebtBase: debt.toString(),
      healthFactorWad: healthFactor.toString(),
      liquidationEligible: debt > 0n && healthFactor > 0n && healthFactor < 10n ** 18n
    };
  } finally {
    await provider.destroy();
  }
}
