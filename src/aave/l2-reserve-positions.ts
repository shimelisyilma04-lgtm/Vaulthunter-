import { Contract, JsonRpcProvider, encodeBytes32String, getAddress } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "./l2-readonly.js";
import { quoteMultiChainUniswapV3 } from "../chain/uniswap-v3-quote.js";
import { calculateNetProfit } from "../domain/net-profit.js";

const PROVIDER_ABI = [
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function getAddress(bytes32 id) view returns (address)"
] as const;
const POOL_ABI = [
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserConfiguration(address) view returns (tuple(uint256 data))",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns (tuple(tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function getUserEMode(address) view returns (uint256)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD() view returns (uint256)",
  "function MIN_LEFTOVER_BASE() view returns (uint256)"
] as const;
const POOL_EMODE_BITMAP_ABI = [
  "function getEModeCategoryData(uint8) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,uint128 collateralBitmap,uint128 borrowableBitmap,string label)"
] as const;
const POOL_EMODE_LEGACY_ABI = [
  "function getEModeCategoryData(uint8) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label)"
] as const;
const POOL_EMODE_COLLATERAL_BITMAP_ABI = [
  "function getEModeCategoryCollateralBitmap(uint8) view returns (uint128)"
] as const;
const ORACLE_ABI = [
  "function getAssetPrice(address) view returns (uint256)",
  "function BASE_CURRENCY() view returns (address)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)"
] as const;
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
] as const;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000";

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  throw new Error("Invalid Aave " + label);
}
function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("Division denominator must be positive");
  return n === 0n ? 0n : (n + d - 1n) / d;
}
export function aavePercentMulHalfUp(value: bigint, percentage: bigint): bigint {
  return (value * percentage + BPS / 2n) / BPS;
}
export function aavePercentMulFloor(value: bigint, percentage: bigint): bigint {
  return value * percentage / BPS;
}
export function aavePercentMulCeil(value: bigint, percentage: bigint): bigint {
  return ceilDiv(value * percentage, BPS);
}
export function aavePercentDivFloor(value: bigint, percentage: bigint): bigint {
  if (percentage === 0n) throw new Error("Liquidation bonus must be positive");
  return value * BPS / percentage;
}
export function aavePercentDivCeil(value: bigint, percentage: bigint): bigint {
  if (percentage === 0n) throw new Error("Liquidation bonus must be positive");
  return ceilDiv(value * BPS, percentage);
}
export function aaveL2CloseFactorBps(
  healthFactorWad: bigint,
  debtReserveBase: bigint,
  collateralReserveBase: bigint,
  minBaseThreshold: bigint | null
): bigint | null {
  if (minBaseThreshold === null) return null;
  return healthFactorWad > 95n * WAD / 100n &&
    debtReserveBase >= minBaseThreshold &&
    collateralReserveBase >= minBaseThreshold ? 5_000n : 10_000n;
}
export function aaveL2UsesLegacyEModePrice(
  userCategory: number,
  reserveCategory: number,
  priceSource: string,
  asCollateral: boolean
): boolean {
  return userCategory > 0 && priceSource.toLowerCase() !== ZERO &&
    (!asCollateral || reserveCategory === userCategory);
}
export function aaveL2UsesEModeCollateralBitmap(
  userCategory: number,
  reserveId: number,
  collateralBitmap: bigint
): boolean {
  return userCategory > 0 && reserveId >= 0 && reserveId < 128 &&
    (collateralBitmap & (1n << BigInt(reserveId))) !== 0n;
}
export function aaveL2DustSatisfied(
  debtRemainingBase: bigint,
  collateralRemainingBase: bigint,
  minLeftoverBase: bigint | null,
  debtFullyCleared: boolean,
  collateralFullyCleared: boolean
): boolean {
  return debtFullyCleared || collateralFullyCleared ||
    (minLeftoverBase !== null && debtRemainingBase >= minLeftoverBase && collateralRemainingBase >= minLeftoverBase);
}

export interface AaveL2ReservePosition {
  asset: string;
  symbol: string;
  decimals: number;
  reserveId: number;
  eModeCategory: number;
  aToken: string;
  stableDebtToken: string;
  variableDebtToken: string;
  collateralBalance: string;
  stableDebt: string;
  variableDebt: string;
  totalDebt: string;
  collateralEnabled: boolean;
  liquidationBonusBps: string;
  liquidationProtocolFeeBps: string;
  priceBase: string;
  collateralValueBase: string;
  debtValueBase: string;
  flashLoanEnabled: boolean;
  flashLoanLiquidity: string;
}
export interface AaveL2LiquidationPair {
  collateralAsset: string;
  collateralSymbol: string;
  collateralDecimals: number;
  debtAsset: string;
  debtSymbol: string;
  debtDecimals: number;
  requestedDebtToCover: string;
  actualDebtToCover: string;
  grossCollateralSeized: string;
  protocolFeeCollateral: string;
  netCollateralReceived: string;
  debtRemainingBase: string;
  collateralRemainingBase: string;
  liquidationBonusBps: string;
  liquidationProtocolFeeBps: string;
  closeFactorBps: string;
  dustRuleSatisfied: boolean;
  dustRule: string;
  flashLoanPremiumBps: string;
  flashLoanAvailable: boolean;
  estimatedGrossBonusBase: string;
  collateralPriceBase: string;
  debtPriceBase: string;
}
export interface AaveL2ReserveSnapshot {
  network: AaveL2Network;
  chainId: number;
  pool: string;
  oracle: string;
  user: string;
  observedBlock: number;
  blockTimestamp: number;
  baseCurrency: string;
  baseCurrencyUnit: string;
  totalCollateralBase: string;
  totalDebtBase: string;
  healthFactorWad: string;
  liquidationEligible: boolean;
  userEModeCategory: number;
  eModeCategory: { profile: "bitmap" | "legacy-price-source"; liquidationBonusBps: string; collateralBitmap?: string; priceSource?: string; label: string } | null;
  flashLoanPremiumBps: string;
  minBaseMaxCloseFactorThreshold: string | null;
  minLeftoverBase: string | null;
  reserves: AaveL2ReservePosition[];
  pairs: AaveL2LiquidationPair[];
  warnings: string[];
}

/**
 * Reads Aave reserve configuration, user balances, prices, flash-loan premium
 * and liquidation parameters from one pinned block on Base or Arbitrum.
 * Unsupported/missing optional protocol getters are reported rather than guessed.
 */
export async function inspectAaveL2ReservePositions(args: {
  network: AaveL2Network;
  rpcUrl: string;
  borrower: string;
  confirmations?: number;
}): Promise<AaveL2ReserveSnapshot> {
  const borrower = getAddress(args.borrower);
  const deployment = AAVE_V3_MARKETS[args.network];
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(deployment.chainId)) {
      throw new Error("Expected Aave chain " + deployment.chainId + "; received " + chain.chainId);
    }
    const head = await provider.getBlockNumber();
    const observedBlock = Math.max(0, head - Math.max(0, args.confirmations ?? 0));
    const block = await provider.getBlock(observedBlock);
    if (!block) throw new Error("Could not read the pinned Aave block timestamp");
    const addressesProvider = new Contract(deployment.addressesProvider, PROVIDER_ABI, provider);
    const [poolAddressRaw, oracleAddressRaw] = await Promise.all([
      addressesProvider.getFunction("getPool").staticCall({ blockTag: observedBlock }),
      addressesProvider.getFunction("getPriceOracle").staticCall({ blockTag: observedBlock })
    ]);
    const poolAddress = getAddress(String(poolAddressRaw));
    if (poolAddress !== getAddress(deployment.expectedPool)) throw new Error("Aave Pool proxy does not match the pinned official deployment address for " + args.network + ".");
    const oracleAddress = getAddress(String(oracleAddressRaw));
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);
    const [accountRaw, userConfigRaw, reservesRaw, eModeRaw, baseCurrencyRaw, baseUnitRaw, flashPremiumRaw, mockStableDebtRaw] = await Promise.all([
      pool.getFunction("getUserAccountData").staticCall(borrower, { blockTag: observedBlock }),
      pool.getFunction("getUserConfiguration").staticCall(borrower, { blockTag: observedBlock }),
      pool.getFunction("getReservesList").staticCall({ blockTag: observedBlock }),
      pool.getFunction("getUserEMode").staticCall(borrower, { blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY").staticCall({ blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY_UNIT").staticCall({ blockTag: observedBlock }),
      pool.getFunction("FLASHLOAN_PREMIUM_TOTAL").staticCall({ blockTag: observedBlock }),
      addressesProvider.getFunction("getAddress").staticCall(encodeBytes32String("MOCK_STABLE_DEBT"), { blockTag: observedBlock })
    ]);
    const account = accountRaw as readonly bigint[];
    const userBitmap = asBigInt((userConfigRaw as readonly [bigint])[0], "user configuration");
    const reserveAddresses = reservesRaw as readonly string[];
    const baseUnit = asBigInt(baseUnitRaw, "base currency unit");
    const baseCurrencyAddress = getAddress(String(baseCurrencyRaw));
    const userEModeCategory = Number(asBigInt(eModeRaw, "user eMode"));
    if (baseUnit === 0n) throw new Error("Aave returned a zero base-currency unit");
    const flashLoanPremiumBps = asBigInt(flashPremiumRaw, "flash-loan premium");
    const mockStableDebtAddress = getAddress(String(mockStableDebtRaw));
    let minBaseThreshold: bigint | null = null;
    let minLeftover: bigint | null = null;
    try {
      minBaseThreshold = asBigInt(await pool.getFunction("MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD").staticCall({ blockTag: observedBlock }), "minimum close-factor threshold");
      minLeftover = asBigInt(await pool.getFunction("MIN_LEFTOVER_BASE").staticCall({ blockTag: observedBlock }), "minimum leftover");
    } catch {
      // Aave V3 Origin defines these as public constants on the linked LiquidationLogic
      // library, not guaranteed getters on the Pool proxy. Its default profile is
      // USD with 8 decimals: 2,000e8 close-factor threshold and half that as dust.
      if (baseCurrencyAddress.toLowerCase() === ZERO && baseUnit === 10n ** 8n) {
        minBaseThreshold = 2_000n * baseUnit;
        minLeftover = minBaseThreshold / 2n;
      }
    }
    let eModeData:
      | { profile: "bitmap"; liquidationBonusBps: string; collateralBitmap: string; label: string }
      | { profile: "legacy-price-source"; liquidationBonusBps: string; priceSource: string; label: string }
      | null = null;
    if (userEModeCategory > 0) {
      let categoryData: readonly unknown[] | null = null;
      let categoryProfile: "bitmap-tuple" | "legacy" | null = null;
      try {
        categoryData = await new Contract(poolAddress, POOL_EMODE_LEGACY_ABI, provider)
          .getFunction("getEModeCategoryData").staticCall(userEModeCategory, { blockTag: observedBlock }) as readonly unknown[];
        categoryProfile = "legacy";
      } catch {
        try {
          categoryData = await new Contract(poolAddress, POOL_EMODE_BITMAP_ABI, provider)
            .getFunction("getEModeCategoryData").staticCall(userEModeCategory, { blockTag: observedBlock }) as readonly unknown[];
          categoryProfile = "bitmap-tuple";
        } catch {
          throw new Error("User has an eMode category but its liquidation bonus ABI could not be decoded; pair estimates are withheld.");
        }
      }
      const liquidationBonusBps = asBigInt(categoryData[2], "eMode liquidation bonus").toString();
      if (categoryProfile === "bitmap-tuple") {
        eModeData = {
          profile: "bitmap",
          liquidationBonusBps,
          collateralBitmap: asBigInt(categoryData[3], "eMode collateral bitmap").toString(),
          label: String(categoryData[5])
        };
      } else {
        try {
          const bitmap = await new Contract(poolAddress, POOL_EMODE_COLLATERAL_BITMAP_ABI, provider)
            .getFunction("getEModeCategoryCollateralBitmap").staticCall(userEModeCategory, { blockTag: observedBlock });
          eModeData = {
            profile: "bitmap",
            liquidationBonusBps,
            collateralBitmap: asBigInt(bitmap, "eMode collateral bitmap").toString(),
            label: String(categoryData[4])
          };
        } catch {
          eModeData = {
            profile: "legacy-price-source",
            liquidationBonusBps,
            priceSource: getAddress(String(categoryData[3])),
            label: String(categoryData[4])
          };
        }
      }
    }
    const reserves: AaveL2ReservePosition[] = [];
    for (let i = 0; i < reserveAddresses.length; i += 1) {
      const batch = reserveAddresses.slice(i, i + 1);
      const rows = await Promise.all(batch.map(async (assetRaw, j) => {
        const reserveIndex = i + j;
        const asset = getAddress(assetRaw);
        const [reserveRaw, priceRaw, decimalsRaw, symbolRaw] = await Promise.all([
          pool.getFunction("getReserveData").staticCall(asset, { blockTag: observedBlock }),
          oracle.getFunction("getAssetPrice").staticCall(asset, { blockTag: observedBlock }),
          new Contract(asset, ERC20_ABI, provider).getFunction("decimals").staticCall({ blockTag: observedBlock }),
          new Contract(asset, ERC20_ABI, provider).getFunction("symbol").staticCall({ blockTag: observedBlock })
        ]);
        const reserve = (reserveRaw as readonly [readonly [bigint], ...unknown[]]);
        const reserveTuple = reserve[0] as readonly [bigint];
        const config = asBigInt(reserveTuple[0], "reserve configuration");
        const reserveData = reserveRaw as readonly unknown[];
        const reserveId = Number(asBigInt(reserveData[7], "reserve id"));
        const aToken = getAddress(String(reserveData[8]));
        const stableDebtToken = getAddress(String(reserveData[9]));
        const variableDebtToken = getAddress(String(reserveData[10]));
        const decimals = Number(asBigInt(decimalsRaw, "token decimals"));
        const collateralEnabled = ((userBitmap >> BigInt(2 * reserveId + 1)) & 1n) === 1n;
        const borrowing = ((userBitmap >> BigInt(2 * reserveId)) & 1n) === 1n;
        if (!collateralEnabled && !borrowing) return null;
        const [collateralRaw, stableRaw, variableRaw, flashLiquidityRaw] = await Promise.all([
          new Contract(aToken, ERC20_ABI, provider).getFunction("balanceOf").staticCall(borrower, { blockTag: observedBlock }),
          stableDebtToken === ZERO || stableDebtToken.toLowerCase() === mockStableDebtAddress.toLowerCase() ? 0n : new Contract(stableDebtToken, ERC20_ABI, provider).getFunction("balanceOf").staticCall(borrower, { blockTag: observedBlock }),
          variableDebtToken === ZERO ? 0n : new Contract(variableDebtToken, ERC20_ABI, provider).getFunction("balanceOf").staticCall(borrower, { blockTag: observedBlock }),
          new Contract(asset, ERC20_ABI, provider).getFunction("balanceOf").staticCall(aToken, { blockTag: observedBlock })
        ]);
        const collateral = asBigInt(collateralRaw, "aToken balance");
        const stableDebt = asBigInt(stableRaw, "stable debt");
        const variableDebt = asBigInt(variableRaw, "variable debt");
        const totalDebt = stableDebt + variableDebt;
        const price = asBigInt(priceRaw, "reserve oracle price");
        const unit = 10n ** BigInt(decimals);
        const reserveEModeCategory = Number((config >> 168n) & 0xffn);
        const bonus = (config >> 32n) & 0xffffn;
        const protocolFee = (config >> 152n) & 0xffffn;
        const flashLoanEnabled = ((config >> 63n) & 1n) === 1n;
        return {
          asset, symbol: String(symbolRaw), decimals, reserveId, eModeCategory: reserveEModeCategory,
          aToken, stableDebtToken, variableDebtToken,
          collateralBalance: collateral.toString(), stableDebt: stableDebt.toString(),
          variableDebt: variableDebt.toString(), totalDebt: totalDebt.toString(),
          collateralEnabled, liquidationBonusBps: bonus.toString(),
          liquidationProtocolFeeBps: protocolFee.toString(), priceBase: price.toString(),
          collateralValueBase: (collateral * price / unit).toString(),
          debtValueBase: (totalDebt * price / unit).toString(),
          flashLoanEnabled, flashLoanLiquidity: asBigInt(flashLiquidityRaw, "flash-loan liquidity").toString()
        } satisfies AaveL2ReservePosition;
      }));
      reserves.push(...rows.filter((row): row is AaveL2ReservePosition => row !== null));
      if (i + 1 < reserveAddresses.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const priceFor = async (asset: AaveL2ReservePosition, asCollateral: boolean): Promise<bigint> => {
      if (eModeData?.profile === "legacy-price-source" &&
          aaveL2UsesLegacyEModePrice(userEModeCategory, asset.eModeCategory, eModeData.priceSource, asCollateral)) {
        return asBigInt(await oracle.getFunction("getAssetPrice").staticCall(eModeData.priceSource, { blockTag: observedBlock }), "legacy eMode price");
      }
      // Aave Origin's bitmap profile uses the ordinary reserve oracle prices in
      // LiquidationLogic; eMode affects account health and the selected bonus.
      return BigInt(asset.priceBase);
    };
    const pairs: AaveL2LiquidationPair[] = [];
    const hf = asBigInt(account[5], "health factor");
    if (hf > 0n && hf < WAD) {
      const collateralReserves = reserves.filter((r) => r.collateralEnabled && BigInt(r.collateralBalance) > 0n);
      const debtReserves = reserves.filter((r) => BigInt(r.totalDebt) > 0n);
      for (const collateral of collateralReserves) for (const debt of debtReserves) {
        const [collateralPrice, debtPrice] = await Promise.all([
          priceFor(collateral, true), priceFor(debt, false)
        ]);
        if (collateralPrice === 0n || debtPrice === 0n) continue;
        const eModeCollateral = eModeData?.profile === "bitmap"
          ? aaveL2UsesEModeCollateralBitmap(userEModeCategory, collateral.reserveId, BigInt(eModeData.collateralBitmap))
          : eModeData?.profile === "legacy-price-source" && collateral.eModeCategory === userEModeCategory;
        const bonus = eModeCollateral
          ? BigInt(eModeData!.liquidationBonusBps)
          : BigInt(collateral.liquidationBonusBps);
        if (bonus <= BPS) continue;
        const collateralUnit = 10n ** BigInt(collateral.decimals);
        const debtUnit = 10n ** BigInt(debt.decimals);
        const debtBase = ceilDiv(BigInt(debt.totalDebt) * debtPrice, debtUnit);
        const collateralBase = BigInt(collateral.collateralBalance) * collateralPrice / collateralUnit;
        const totalDebtBase = asBigInt(account[1], "total debt base");
        let maxDebtBase = debtBase;
        const closeFactorBps = aaveL2CloseFactorBps(hf, debtBase, collateralBase, minBaseThreshold);
        if (closeFactorBps === null) continue;
        if (closeFactorBps === 5_000n) {
          const halfAccountDebt = aavePercentMulHalfUp(totalDebtBase, 5_000n);
          if (debtBase > halfAccountDebt) maxDebtBase = halfAccountDebt;
        }
        const requestedDebt = maxDebtBase * debtUnit / debtPrice;
        const baseCollateral = debtPrice * requestedDebt * collateralUnit / (collateralPrice * debtUnit);
        const maxCollateral = aavePercentMulFloor(baseCollateral, bonus);
        let seized = maxCollateral;
        let actualDebt = requestedDebt;
        if (maxCollateral > BigInt(collateral.collateralBalance)) {
          seized = BigInt(collateral.collateralBalance);
          const debtValue = collateralPrice * seized * debtUnit / (debtPrice * collateralUnit);
          actualDebt = aavePercentDivCeil(debtValue, bonus);
        }
        const bonusCollateral = seized - aavePercentDivFloor(seized, bonus);
        const protocolFee = aavePercentMulCeil(bonusCollateral, BigInt(collateral.liquidationProtocolFeeBps));
        const netCollateral = seized - protocolFee;
        const debtRemaining = BigInt(debt.totalDebt) - actualDebt;
        const collateralRemaining = BigInt(collateral.collateralBalance) - seized;
        const debtRemainingBase = ceilDiv(debtRemaining * debtPrice, debtUnit);
        const collateralRemainingBase = collateralRemaining * collateralPrice / collateralUnit;
        const debtFullyCleared = actualDebt >= BigInt(debt.totalDebt);
        const collateralFullyCleared = seized >= BigInt(collateral.collateralBalance);
        const dustSatisfied = aaveL2DustSatisfied(debtRemainingBase, collateralRemainingBase, minLeftover, debtFullyCleared, collateralFullyCleared);
        const dustRule = minLeftover === null
          ? "Pool does not expose MIN_LEFTOVER_BASE; exact dust validation requires fork simulation."
          : debtFullyCleared ? "Selected debt reserve fully repaid."
          : collateralFullyCleared ? "Selected collateral reserve fully consumed."
          : dustSatisfied ? "Both remaining reserve balances exceed MIN_LEFTOVER_BASE."
          : "Partial liquidation leaves debt or collateral below MIN_LEFTOVER_BASE.";
        const flashAvailable = debt.flashLoanEnabled && BigInt(debt.flashLoanLiquidity) >= actualDebt;
        const effectiveBonus = bonus;
        const grossBonusBase = seized * collateralPrice / collateralUnit - actualDebt * debtPrice / debtUnit;
        pairs.push({
          collateralAsset: collateral.asset, collateralSymbol: collateral.symbol,
          collateralDecimals: collateral.decimals, debtAsset: debt.asset, debtSymbol: debt.symbol,
          debtDecimals: debt.decimals, requestedDebtToCover: requestedDebt.toString(),
          actualDebtToCover: actualDebt.toString(), grossCollateralSeized: seized.toString(),
          protocolFeeCollateral: protocolFee.toString(), netCollateralReceived: netCollateral.toString(),
          debtRemainingBase: debtRemainingBase.toString(), collateralRemainingBase: collateralRemainingBase.toString(),
          liquidationBonusBps: effectiveBonus.toString(),
          liquidationProtocolFeeBps: collateral.liquidationProtocolFeeBps,
          closeFactorBps: closeFactorBps.toString(), dustRuleSatisfied: dustSatisfied,
          dustRule, flashLoanPremiumBps: flashLoanPremiumBps.toString(),
          flashLoanAvailable: flashAvailable, estimatedGrossBonusBase: grossBonusBase.toString(),
          collateralPriceBase: collateralPrice.toString(), debtPriceBase: debtPrice.toString()
        });
      }
    }
    const blockPriceSourceWarning = eModeData?.profile === "bitmap"
      ? "Aave Origin eMode bitmap profile: ordinary reserve oracle prices are used for pair sizing and the category liquidation bonus is applied only to reserves in the collateral bitmap."
      : eModeData?.profile === "legacy-price-source"
        ? "Legacy eMode profile: the category price source is applied to debt and matching-category collateral prices."
        : "";
    return {
      network: args.network, chainId: deployment.chainId, pool: poolAddress, oracle: oracleAddress,
      user: borrower, observedBlock, blockTimestamp: block.timestamp,
      baseCurrency: baseCurrencyAddress, baseCurrencyUnit: baseUnit.toString(),
      totalCollateralBase: asBigInt(account[0], "total collateral base").toString(),
      totalDebtBase: asBigInt(account[1], "total debt base").toString(),
      healthFactorWad: hf.toString(), liquidationEligible: hf > 0n && hf < WAD,
      userEModeCategory, eModeCategory: eModeData, flashLoanPremiumBps: flashLoanPremiumBps.toString(),
      minBaseMaxCloseFactorThreshold: minBaseThreshold?.toString() ?? null,
      minLeftoverBase: minLeftover?.toString() ?? null, reserves, pairs,
      warnings: [
        "All Aave account, reserve, token-balance, price, eMode and flash-premium reads use one confirmed block.",
        "When Pool getters are unavailable, the calculator uses Aave Origin source constants only for the USD/1e8 base-currency profile (2,000e8 close-factor threshold; 1,000e8 dust threshold); other base-currency profiles fail closed. Close-factor selection uses the specific debt-reserve and collateral-reserve base values, not total account debt. The rounding profile follows current Aave Origin source and still requires deployed-implementation fork verification.",
        "Flash-loan liquidity is a point-in-time underlying balance and can change before execution.",
        blockPriceSourceWarning,
        "This endpoint does not sign, broadcast, or submit transactions."
      ].filter(Boolean)
    };
  } finally {
    await provider.destroy();
  }
}


export interface AaveL2PairProfitInput {
  snapshot: AaveL2ReserveSnapshot;
  pair: AaveL2LiquidationPair;
  rpcUrl: string;
  gasUnits: string;
  slippageBps: number;
  mevBudgetDebtTokenUnits: string;
  builderFeeDebtTokenUnits: string;
  safetyBufferBps: number;
}
export async function estimateAaveL2PairNetProfit(input: AaveL2PairProfitInput): Promise<{
  network: AaveL2Network;
  observedBlock: number;
  collateralToDebtQuote: string | null;
  quoteFeeTier: number | null;
  quoteBlock: number | null;
  gasCostDebtTokenUnits: string;
  flashLoanFeeDebtTokenUnits: string;
  slippageHaircutDebtTokenUnits: string;
  mevBudgetDebtTokenUnits: string;
  builderFeeDebtTokenUnits: string;
  safetyBufferDebtTokenUnits: string;
  estimatedNetProfitDebtTokenUnits: string | null;
  estimatedNetProfitBaseCurrency: string | null;
  positiveAfterAllBudgets: boolean;
  flashLoanAvailable: boolean;
  source: string;
  warnings: string[];
}> {
  const uint = (value: string, label: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) throw new Error(label + " must be an unsigned integer string");
    return BigInt(value);
  };
  const bps = (value: number, label: string): bigint => {
    if (!Number.isInteger(value) || value < 0 || value >= 10_000) throw new Error(label + " must be 0-9999 bps");
    return BigInt(value);
  };
  const ceil = (n: bigint, d: bigint) => n === 0n ? 0n : (n + d - 1n) / d;
  const gasUnits = uint(input.gasUnits, "gasUnits");
  const mevBudget = uint(input.mevBudgetDebtTokenUnits, "mevBudgetDebtTokenUnits");
  const builderFee = uint(input.builderFeeDebtTokenUnits, "builderFeeDebtTokenUnits");
  const slippageBps = bps(input.slippageBps, "slippageBps");
  const safetyBps = bps(input.safetyBufferBps, "safetyBufferBps");
  const debt = input.snapshot.reserves.find((r) => r.asset.toLowerCase() === input.pair.debtAsset.toLowerCase());
  if (!debt) throw new Error("Debt reserve was not present in the pinned Aave snapshot");
  const debtUnit = 10n ** BigInt(input.pair.debtDecimals);
  const debtPrice = uint(input.pair.debtPriceBase, "debtPriceBase");
  if (debtPrice === 0n) throw new Error("Debt reserve oracle price is zero");
  const flashFee = ceil(uint(input.pair.actualDebtToCover, "actualDebtToCover") *
    uint(input.pair.flashLoanPremiumBps, "flashLoanPremiumBps"), BPS);
  const provider = new JsonRpcProvider(input.rpcUrl);
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(input.snapshot.chainId)) throw new Error("RPC chain changed since the snapshot");
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (maxFeePerGas === null) throw new Error("RPC did not provide a gas price");
    const wrappedNative = input.snapshot.network === "base"
      ? "0x4200000000000000000000000000000000000006"
      : "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const oracle = new Contract(input.snapshot.oracle, ORACLE_ABI, provider);
    const nativePrice = uint(String(await oracle.getFunction("getAssetPrice").staticCall(
      wrappedNative, { blockTag: input.snapshot.observedBlock }
    )), "native asset oracle price");
    const gasCostBase = ceil(gasUnits * maxFeePerGas * nativePrice, WAD);
    const gasCostDebtUnits = ceil(gasCostBase * debtUnit, debtPrice);
    const quote = await quoteMultiChainUniswapV3({
      network: input.snapshot.network,
      rpcUrl: input.rpcUrl,
      tokenIn: input.pair.collateralAsset,
      tokenOut: input.pair.debtAsset,
      amountIn: input.pair.netCollateralReceived,
      blockNumber: input.snapshot.observedBlock
    });
    if (quote.amountOut === null) {
      return {
        network: input.snapshot.network, observedBlock: input.snapshot.observedBlock,
        collateralToDebtQuote: null, quoteFeeTier: null, quoteBlock: quote.blockNumber,
        gasCostDebtTokenUnits: gasCostDebtUnits.toString(),
        flashLoanFeeDebtTokenUnits: flashFee.toString(),
        slippageHaircutDebtTokenUnits: "0", mevBudgetDebtTokenUnits: mevBudget.toString(),
        builderFeeDebtTokenUnits: builderFee.toString(), safetyBufferDebtTokenUnits: "0",
        estimatedNetProfitDebtTokenUnits: null, estimatedNetProfitBaseCurrency: null, positiveAfterAllBudgets: false,
        flashLoanAvailable: input.pair.flashLoanAvailable, source: "uniswap-v3-quoter-v2",
        warnings: ["No direct Uniswap V3 pool returned a quote for this pair. Multi-hop routing is not yet included."]
      };
    }
    const quotedOut = uint(quote.amountOut, "quote amount out");
    const debtToCover = uint(input.pair.actualDebtToCover, "actualDebtToCover");
    const haircutProceeds = quotedOut * (BPS - slippageBps) / BPS;
    const grossAfterRepayment = haircutProceeds > debtToCover ? haircutProceeds - debtToCover : 0n;
    const safetyBuffer = ceil(grossAfterRepayment * safetyBps, BPS);
    const netResult = calculateNetProfit({
      swapProceeds: quotedOut.toString(), repayment: debtToCover.toString(),
      flashLoanFee: flashFee.toString(), gasCost: gasCostDebtUnits.toString(),
      mevBudget: mevBudget.toString(), builderFee: builderFee.toString(),
      safetyBuffer: safetyBuffer.toString(), slippageBps: Number(slippageBps)
    });
    const net = BigInt(netResult.netProfit);
    const slippageHaircut = BigInt(netResult.slippageHaircut);
    return {
      network: input.snapshot.network, observedBlock: input.snapshot.observedBlock,
      collateralToDebtQuote: quote.amountOut, quoteFeeTier: quote.selectedFee,
      quoteBlock: quote.blockNumber, gasCostDebtTokenUnits: gasCostDebtUnits.toString(),
      flashLoanFeeDebtTokenUnits: flashFee.toString(),
      slippageHaircutDebtTokenUnits: slippageHaircut.toString(),
      mevBudgetDebtTokenUnits: mevBudget.toString(), builderFeeDebtTokenUnits: builderFee.toString(),
      safetyBufferDebtTokenUnits: safetyBuffer.toString(),
      estimatedNetProfitDebtTokenUnits: net.toString(),
      estimatedNetProfitBaseCurrency: (net * debtPrice / debtUnit).toString(),
      positiveAfterAllBudgets: net > 0n && input.pair.dustRuleSatisfied && input.pair.flashLoanAvailable,
      flashLoanAvailable: input.pair.flashLoanAvailable,
      source: "same-block-uniswap-quote-plus-live-aave-flashloan-premium-and-rpc-gas-price",
      warnings: [
        "gasUnits is an explicit caller-provided estimate; without a reviewed flash-loan executor it is not a measured end-to-end liquidation gas estimate.",
        "Aave flash-loan availability is checked from the reserve's point-in-time liquidity balance and may change before execution.",
        "The Uniswap quote is direct-pool only. The slippage haircut is a configured stress allowance, not a guarantee.",
        "MEV and builder budgets are caller-provided; a zero budget does not mean MEV risk is zero.",
        "A positive screen is not a transaction-level simulation or execution guarantee. No signing or submission occurs."
      ]
    };
  } finally {
    await provider.destroy();
  }
}


export async function getAaveL2FlashLoanTerms(args: {
  network: AaveL2Network;
  rpcUrl: string;
  asset: string;
  blockNumber: number;
}): Promise<{
  pool: string;
  oracle: string;
  asset: string;
  decimals: number;
  flashLoanEnabled: boolean;
  availableLiquidity: string;
  flashLoanPremiumBps: string;
  assetPriceBase: string;
  nativePriceBase: string;
  maxFeePerGasWei: string;
}> {
  const deployment = AAVE_V3_MARKETS[args.network];
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(deployment.chainId)) throw new Error("Flash-loan terms RPC chain mismatch");
    const addressesProvider = new Contract(deployment.addressesProvider, PROVIDER_ABI, provider);
    const [poolRaw, oracleRaw] = await Promise.all([
      addressesProvider.getFunction("getPool").staticCall({ blockTag: args.blockNumber }),
      addressesProvider.getFunction("getPriceOracle").staticCall({ blockTag: args.blockNumber })
    ]);
    const poolAddress = getAddress(String(poolRaw));
    const oracleAddress = getAddress(String(oracleRaw));
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const reserveRaw = await pool.getFunction("getReserveData").staticCall(args.asset, { blockTag: args.blockNumber }) as readonly unknown[];
    const configRaw = await pool.getFunction("getConfiguration").staticCall(args.asset, { blockTag: args.blockNumber }) as readonly [readonly [bigint]];
    const reserveConfig = asBigInt(configRaw[0][0], "flash-loan reserve configuration");
    const aToken = getAddress(String(reserveRaw[8]));
    const asset = getAddress(args.asset);
    const erc20 = new Contract(asset, ERC20_ABI, provider);
    const [decimalsRaw, liquidityRaw, premiumRaw, assetPriceRaw, feeData] = await Promise.all([
      erc20.getFunction("decimals").staticCall({ blockTag: args.blockNumber }),
      erc20.getFunction("balanceOf").staticCall(aToken, { blockTag: args.blockNumber }),
      pool.getFunction("FLASHLOAN_PREMIUM_TOTAL").staticCall({ blockTag: args.blockNumber }),
      new Contract(oracleAddress, ORACLE_ABI, provider).getFunction("getAssetPrice").staticCall(asset, { blockTag: args.blockNumber }),
      provider.getFeeData()
    ]);
    const wrappedNative = args.network === "base"
      ? "0x4200000000000000000000000000000000000006"
      : "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const nativePriceRaw = await new Contract(oracleAddress, ORACLE_ABI, provider)
      .getFunction("getAssetPrice").staticCall(wrappedNative, { blockTag: args.blockNumber });
    const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (maxFee === null) throw new Error("RPC did not provide a gas price");
    return {
      pool: poolAddress, oracle: oracleAddress, asset, decimals: Number(asBigInt(decimalsRaw, "flash-loan asset decimals")),
      flashLoanEnabled: ((reserveConfig >> 63n) & 1n) === 1n,
      availableLiquidity: asBigInt(liquidityRaw, "flash-loan liquidity").toString(),
      flashLoanPremiumBps: asBigInt(premiumRaw, "flash-loan premium").toString(),
      assetPriceBase: asBigInt(assetPriceRaw, "flash-loan asset price").toString(),
      nativePriceBase: asBigInt(nativePriceRaw, "native asset price").toString(),
      maxFeePerGasWei: maxFee.toString()
    };
  } finally {
    await provider.destroy();
  }
}
