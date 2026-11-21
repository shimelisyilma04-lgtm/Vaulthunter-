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
  borrowShares: string;
  totalBorrowAssets: string;
  totalBorrowShares: string;
  collateralAssets: string;
  oraclePrice: string;
  borrowRatePerSecondWad: string;
  accruedTotalBorrowAssets: string;
  accruedBorrowAssets: string;
  accrualTimestamp: number;
  elapsedSeconds: number;
  liquidationEligible: boolean;
  observedBlock: number;
}

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const MORPHO_IRM_ABI = [
  "function borrowRate((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns (uint256)"
] as const;

function taylorCompounded(rateWad: bigint, elapsedSeconds: bigint): bigint {
  const x = rateWad * elapsedSeconds;
  const x2 = x * x / WAD;
  const x3 = x2 * x / WAD;
  const x4 = x3 * x / WAD;
  const x5 = x4 * x / WAD;
  return x + x2 / 2n + x3 / 6n + x4 / 24n + x5 / 120n;
}

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
    const lastUpdate = asBigInt(market[4], "last update");
    const marketFee = asBigInt(market[5], "market fee");
    const block = await provider.getBlock(blockNumber);
    if (!block) throw new Error("Could not load pinned block timestamp");
    const elapsedSeconds = BigInt(block.timestamp) > lastUpdate
      ? BigInt(block.timestamp) - lastUpdate
      : 0n;
    let borrowRatePerSecond = 0n;
    let accruedTotalBorrowAssets = totalBorrowAssets;
    if (elapsedSeconds > 0n && irm.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      const irmContract = new Contract(irm, MORPHO_IRM_ABI, provider);
      borrowRatePerSecond = asBigInt(await irmContract.getFunction("borrowRate")(
        { loanToken, collateralToken, oracle: oracleAddress, irm, lltv },
        {
          totalSupplyAssets: asBigInt(market[0], "total supply assets"),
          totalSupplyShares: asBigInt(market[1], "total supply shares"),
          totalBorrowAssets,
          totalBorrowShares,
          lastUpdate,
          fee: marketFee
        },
        { blockTag: blockNumber }
      ), "IRM borrow rate");
      const compounded = taylorCompounded(borrowRatePerSecond, elapsedSeconds);
      accruedTotalBorrowAssets += totalBorrowAssets * compounded / WAD;
    }
    const accruedBorrowAssets = totalBorrowShares === 0n
      ? 0n
      : (borrowShares * accruedTotalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;

    const oracle = new Contract(oracleAddress, [
      "function price() view returns (uint256)"
    ], provider);
    const oraclePrice = asBigInt(await oracle.getFunction("price")({ blockTag: blockNumber }), "oracle price");
    const borrowAssets = accruedBorrowAssets;

    // Match Morpho.sol _isHealthy rounding: collateral value is floored first,
    // then the LLTV multiplication is floored in loan-token base units.
    const collateralValue = collateral * oraclePrice / ORACLE_PRICE_SCALE;
    const collateralValueAtLltv = collateralValue * lltv / WAD;
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
      borrowShares: borrowShares.toString(),
      totalBorrowAssets: totalBorrowAssets.toString(),
      totalBorrowShares: totalBorrowShares.toString(),
      collateralAssets: collateral.toString(),
      oraclePrice: oraclePrice.toString(),
      borrowRatePerSecondWad: borrowRatePerSecond.toString(),
      accruedTotalBorrowAssets: accruedTotalBorrowAssets.toString(),
      accruedBorrowAssets: accruedBorrowAssets.toString(),
      accrualTimestamp: block.timestamp,
      elapsedSeconds: Number(elapsedSeconds),
      liquidationEligible,
      observedBlock: blockNumber
    };
  } finally {
    await provider.destroy();
  }
}
