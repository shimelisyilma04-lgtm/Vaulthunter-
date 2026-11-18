import { Contract, JsonRpcProvider, getAddress, type Provider } from "ethers";

export const MORPHO_BLUE_ABI = [
  "function idToMarketParams(bytes32 id) view returns (tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
  "function market(bytes32 id) view returns (tuple(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))",
  "function position(bytes32 id,address user) view returns (tuple(uint256 supplyShares,uint128 borrowShares,uint128 collateral))"
] as const;

export const MORPHO_BLUE_ADDRESSES = {
  base: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  arbitrum: "0x6c247b1F6182318877311737BaC0844bAa518F5e"
} as const;

export type MorphoNetwork = keyof typeof MORPHO_BLUE_ADDRESSES;

export interface MorphoPositionSnapshot {
  chainId: 8453 | 42161;
  marketId: string;
  morpho: string;
  borrower: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltvWad: string;
  borrowAssets: string;
  collateralAssets: string;
  oraclePrice: string;
  liquidationEligible: boolean;
  observedBlock: number;
}

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  throw new Error(`Invalid Morpho ${label}`);
}

/**
 * Read-only Morpho Blue position check. The caller supplies a market ID and
 * borrower discovered from indexed SupplyCollateral/Borrow events. Oracle
 * price follows Morpho Blue's 1e36 scaling convention. No signing or writes.
 */
export async function inspectMorphoBluePosition(args: {
  network: MorphoNetwork;
  rpcUrl: string;
  marketId: string;
  borrower: string;
}): Promise<MorphoPositionSnapshot> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.marketId)) {
    throw new Error("Morpho market ID must be a 32-byte hex value");
  }
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const network = await provider.getNetwork();
    const expectedChainId = args.network === "base" ? 8453n : 42161n;
    if (network.chainId !== expectedChainId) {
      throw new Error(`Expected chain ${expectedChainId}; received ${network.chainId}`);
    }
    const morphoAddress = MORPHO_BLUE_ADDRESSES[args.network];
    const morpho = new Contract(morphoAddress, MORPHO_BLUE_ABI, provider);
    const blockNumber = await provider.getBlockNumber();
    const overrides = { blockTag: blockNumber };
    const [params, market, position] = await Promise.all([
      morpho.getFunction("idToMarketParams")(args.marketId, overrides),
      morpho.getFunction("market")(args.marketId, overrides),
      morpho.getFunction("position")(args.marketId, getAddress(args.borrower), overrides)
    ]) as [readonly unknown[], readonly unknown[], readonly unknown[]];

    const loanToken = getAddress(String(params[0]));
    const collateralToken = getAddress(String(params[1]));
    const oracleAddress = getAddress(String(params[2]));
    const irm = getAddress(String(params[3]));
    const lltv = asBigInt(params[4], "LLTV");
    const borrowShares = asBigInt(position[1], "borrow shares");
    const collateral = asBigInt(position[2], "collateral");
    const totalBorrowAssets = asBigInt(market[2], "total borrow assets");
    const totalBorrowShares = asBigInt(market[3], "total borrow shares");

    const oracle = new Contract(oracleAddress, [
      "function price() view returns (uint256)"
    ], provider);
    const oraclePrice = asBigInt(await oracle.getFunction("price")({ blockTag: blockNumber }), "oracle price");
    const borrowAssets = totalBorrowShares === 0n
      ? 0n
      : (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;

    // Morpho Blue liquidation threshold: collateral * oraclePrice * LLTV / 1e36.
    const collateralValueAtLltv = collateral * oraclePrice * lltv / ORACLE_PRICE_SCALE / WAD;
    const liquidationEligible = borrowAssets > 0n && collateralValueAtLltv < borrowAssets;

    return {
      chainId: Number(expectedChainId) as 8453 | 42161,
      marketId: args.marketId.toLowerCase(),
      morpho: morphoAddress,
      borrower: getAddress(args.borrower),
      loanToken,
      collateralToken,
      oracle: oracleAddress,
      irm,
      lltvWad: lltv.toString(),
      borrowAssets: borrowAssets.toString(),
      collateralAssets: collateral.toString(),
      oraclePrice: oraclePrice.toString(),
      liquidationEligible,
      observedBlock: blockNumber
    };
  } finally {
    await provider.destroy();
  }
}
