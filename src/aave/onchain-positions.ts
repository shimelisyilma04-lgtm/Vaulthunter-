import { Contract, JsonRpcProvider, getAddress } from "ethers";

const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const DATA_PROVIDER = "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3";
const AAVE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";
const WAD = 10n ** 18n;

const DATA_PROVIDER_ABI = [
  "function getAllReservesTokens() view returns (tuple(string symbol,address tokenAddress)[])",
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)"
] as const;

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function getUserEMode(address user) view returns (uint256)",
  "function getConfiguration(address asset) view returns (tuple(uint256 data))",
  "function getEModeCategoryData(uint8 id) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label)"
] as const;

const ORACLE_ABI = [
  "function getAssetPrice(address asset) view returns (uint256)",
  "function BASE_CURRENCY() view returns (address)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)"
] as const;

interface ReserveToken {
  symbol: string;
  tokenAddress: string;
}

interface ReservePosition {
  asset: string;
  symbol: string;
  eModeCategory: number;
  decimals: number;
  suppliedBalance: string;
  stableDebt: string;
  variableDebt: string;
  totalDebt: string;
  isCollateral: boolean;
  liquidationThreshold: string;
  liquidationBonus: string;
  isActive: boolean;
  isFrozen: boolean;
  oraclePriceBase: string;
  suppliedValueBase: string;
  debtValueBase: string;
}

export function buildScreeningPairs(
  reserves: ReservePosition[],
  healthFactorWad: string,
  userEModeCategory = 0,
  eModeCategoryBonus: string | null = null
): Array<{
  collateralAsset: string;
  collateralSymbol: string;
  collateralBalance: string;
  collateralDecimals: number;
  collateralValueBase: string;
  debtAsset: string;
  debtSymbol: string;
  debtBalance: string;
  debtDecimals: number;
  debtValueBase: string;
  liquidationBonus: string;
  eModeCompatible: boolean;
  effectiveLiquidationBonus: string;
}> {
  if (BigInt(healthFactorWad) >= WAD) return [];
  const collateral = reserves.filter((item) =>
    item.isCollateral && BigInt(item.suppliedBalance) > 0n && item.isActive
  );
  const debts = reserves.filter((item) => BigInt(item.totalDebt) > 0n && item.isActive);
  const pairs = [];
  for (const supply of collateral) {
    for (const debt of debts) {
      // Same-asset combinations are retained; protocol-level validation decides feasibility.
      pairs.push({
        collateralAsset: supply.asset,
        collateralSymbol: supply.symbol,
        collateralBalance: supply.suppliedBalance,
        collateralDecimals: supply.decimals,
        collateralValueBase: supply.suppliedValueBase,
        debtAsset: debt.asset,
        debtSymbol: debt.symbol,
        debtBalance: debt.totalDebt,
        debtDecimals: debt.decimals,
        debtValueBase: debt.debtValueBase,
        liquidationBonus: supply.liquidationBonus,
        eModeCompatible: userEModeCategory > 0 && supply.eModeCategory === userEModeCategory && debt.eModeCategory === userEModeCategory,
        effectiveLiquidationBonus: userEModeCategory > 0 && supply.eModeCategory === userEModeCategory && debt.eModeCategory === userEModeCategory && eModeCategoryBonus !== null ? eModeCategoryBonus : supply.liquidationBonus
      });
    }
  }
  return pairs;
}

/**
 * Fetches reserve balances and Aave oracle prices at one confirmed Ethereum block.
 * This enriches known borrowers; it is not a global borrower-discovery mechanism.
 */
export async function fetchOnchainAavePositions(
  rpcUrl: string,
  userAddress: string,
  confirmations = 12
): Promise<{
  user: string;
  chainId: 1;
  pool: string;
  observedBlock: number;
  healthFactorWad: string;
  healthFactor: number | null;
  userEModeCategory: number;
  eModeCategoryData: { ltv: string; liquidationThreshold: string; liquidationBonus: string; priceSource: string; label: string } | null;
  eModeAwareCalculationReady: boolean;
  baseCurrency: string;
  baseCurrencyUnit: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  liquidationEligibleAtBlock: boolean;
  reserves: ReservePosition[];
  screeningPairs: ReturnType<typeof buildScreeningPairs>;
  source: "aave-v3-protocol-data-provider";
  warning: string;
}> {
  const user = getAddress(userAddress);
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(CHAIN_ID)) {
      throw new Error("On-chain position lookup requires Ethereum mainnet (chain ID 1).");
    }
    const head = await provider.getBlockNumber();
    const observedBlock = Math.max(0, head - confirmations);
    const dataProvider = new Contract(DATA_PROVIDER, DATA_PROVIDER_ABI, provider);
    const pool = new Contract(POOL, POOL_ABI, provider);
    const oracle = new Contract(AAVE_ORACLE, ORACLE_ABI, provider);
    const [tokensRaw, accountRaw, eModeRaw, baseCurrencyRaw, baseUnitRaw] = await Promise.all([
      dataProvider.getFunction("getAllReservesTokens").staticCall({ blockTag: observedBlock }),
      pool.getFunction("getUserAccountData").staticCall(user, { blockTag: observedBlock }),
      pool.getFunction("getUserEMode").staticCall(user, { blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY").staticCall({ blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY_UNIT").staticCall({ blockTag: observedBlock })
    ]);
    const tokens = tokensRaw as readonly ReserveToken[];
    const account = accountRaw as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    const baseCurrencyUnit = BigInt(baseUnitRaw as bigint);
    if (baseCurrencyUnit <= 0n) throw new Error("Aave oracle returned an invalid base-currency unit.");

    const reserves: ReservePosition[] = [];
    for (let offset = 0; offset < tokens.length; offset += 5) {
      const batch = tokens.slice(offset, offset + 5);
      const rows = await Promise.all(batch.map(async (token) => {
        const asset = getAddress(token.tokenAddress);
        const [positionRaw, configRaw, priceRaw, bitmapRaw] = await Promise.all([
          dataProvider.getFunction("getUserReserveData").staticCall(asset, user, { blockTag: observedBlock }),
          dataProvider.getFunction("getReserveConfigurationData").staticCall(asset, { blockTag: observedBlock }),
          oracle.getFunction("getAssetPrice").staticCall(asset, { blockTag: observedBlock }),
          pool.getFunction("getConfiguration").staticCall(asset, { blockTag: observedBlock })
        ]);
        const position = positionRaw as readonly [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean];
        const reserveConfig = configRaw as readonly [bigint,bigint,bigint,bigint,bigint,boolean,boolean,boolean,boolean,boolean];
        const suppliedBalance = position[0];
        const stableDebt = position[1];
        const variableDebt = position[2];
        const totalDebt = stableDebt + variableDebt;
        if (suppliedBalance === 0n && totalDebt === 0n) return null;

        const decimals = Number(reserveConfig[0]);
        const configurationBitmap = BigInt((bitmapRaw as readonly [bigint])[0]);
        const eModeCategory = Number((configurationBitmap >> 168n) & 0xffn);
        const oraclePriceBase = BigInt(priceRaw as bigint);
        const assetUnit = 10n ** BigInt(decimals);
        const suppliedValueBase = suppliedBalance * oraclePriceBase / assetUnit;
        const debtValueBase = totalDebt * oraclePriceBase / assetUnit;

        return {
          asset,
          symbol: token.symbol,
          eModeCategory,
          decimals,
          suppliedBalance: suppliedBalance.toString(),
          stableDebt: stableDebt.toString(),
          variableDebt: variableDebt.toString(),
          totalDebt: totalDebt.toString(),
          isCollateral: position[8],
          liquidationThreshold: reserveConfig[2].toString(),
          liquidationBonus: reserveConfig[3].toString(),
          isActive: reserveConfig[8],
          isFrozen: reserveConfig[9],
          oraclePriceBase: oraclePriceBase.toString(),
          suppliedValueBase: suppliedValueBase.toString(),
          debtValueBase: debtValueBase.toString()
        } satisfies ReservePosition;
      }));
      reserves.push(...rows.filter((row): row is ReservePosition => row !== null));
    }

    const healthFactorWad = account[5].toString();
    const userEModeCategory = Number(eModeRaw as bigint);
    let eModeCategoryData: {
      ltv: string; liquidationThreshold: string; liquidationBonus: string;
      priceSource: string; label: string;
    } | null = null;
    if (userEModeCategory > 0) {
      const categoryRaw = await pool.getFunction("getEModeCategoryData").staticCall(
        userEModeCategory, { blockTag: observedBlock }
      ) as readonly [bigint, bigint, bigint, string, string];
      eModeCategoryData = {
        ltv: categoryRaw[0].toString(),
        liquidationThreshold: categoryRaw[1].toString(),
        liquidationBonus: categoryRaw[2].toString(),
        priceSource: getAddress(categoryRaw[3]),
        label: categoryRaw[4]
      };
    }
    const eModeAwareCalculationReady = userEModeCategory === 0 || (eModeCategoryData !== null && eModeCategoryData.priceSource.toLowerCase() === "0x0000000000000000000000000000000000000000");
    const liquidationEligibleAtBlock = account[1] > 0n && account[5] > 0n && account[5] < WAD;
    return {
      user,
      chainId: 1,
      pool: getAddress(POOL),
      observedBlock,
      healthFactorWad,
      healthFactor: account[5] === (2n ** 256n - 1n) ? null : Number(account[5]) / 1e18,
      userEModeCategory,
      eModeCategoryData,
      eModeAwareCalculationReady,
      baseCurrency: getAddress(baseCurrencyRaw as string),
      baseCurrencyUnit: baseCurrencyUnit.toString(),
      totalCollateralBase: account[0].toString(),
      totalDebtBase: account[1].toString(),
      liquidationEligibleAtBlock,
      reserves,
      screeningPairs: buildScreeningPairs(reserves, healthFactorWad, userEModeCategory, eModeCategoryData?.liquidationBonus ?? null),
      source: "aave-v3-protocol-data-provider",
      warning: "Balances and Aave oracle prices are read at one confirmed block. Base-currency values are not automatically USD unless the market base currency is USD. Reserve eMode-category membership is decoded from Aave reserve configuration. When both selected assets belong to the user category and the category does not override the price source, the category liquidation bonus is used. A non-zero category price source is exposed but not converted into base-currency prices; those accounts are marked as not ready for eMode-aware profitability calculations. Pairs are screening combinations only, not proof a liquidation call will succeed or be profitable. Close factor, protocol fee, flash-loan availability, DEX route, gas and MEV still require transaction-level validation. Borrower discovery remains limited to addresses already known to VaultHunter."
    };
  } finally {
    await provider.destroy();
  }
}
