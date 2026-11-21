import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "./l2-readonly.js";

const PROVIDER_ABI = [
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)"
] as const;
const POOL_ABI = [
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserConfiguration(address) view returns (tuple(uint256 data))",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address) view returns (tuple(tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function getUserEMode(address) view returns (uint256)",
  "function getEModeCategoryData(uint8) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD() view returns (uint256)",
  "function MIN_LEFTOVER_BASE() view returns (uint256)"
] as const;
const ORACLE_ABI = [
  "function getAssetPrice(address) view returns (uint256)",
  "function BASE_CURRENCY() view returns (address)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)"
] as const;
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
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
function percentMulFloor(value: bigint, percentage: bigint): bigint {
  return value * percentage / BPS;
}
function percentDivCeil(value: bigint, percentage: bigint): bigint {
  if (percentage === 0n) throw new Error("Liquidation bonus must be positive");
  return ceilDiv(value * BPS, percentage);
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
  eModeCategory: { liquidationBonusBps: string; priceSource: string } | null;
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
    const oracleAddress = getAddress(String(oracleAddressRaw));
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);
    const [accountRaw, userConfigRaw, reservesRaw, eModeRaw, baseCurrencyRaw, baseUnitRaw, flashPremiumRaw] = await Promise.all([
      pool.getFunction("getUserAccountData").staticCall(borrower, { blockTag: observedBlock }),
      pool.getFunction("getUserConfiguration").staticCall(borrower, { blockTag: observedBlock }),
      pool.getFunction("getReservesList").staticCall({ blockTag: observedBlock }),
      pool.getFunction("getUserEMode").staticCall(borrower, { blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY").staticCall({ blockTag: observedBlock }),
      oracle.getFunction("BASE_CURRENCY_UNIT").staticCall({ blockTag: observedBlock }),
      pool.getFunction("FLASHLOAN_PREMIUM_TOTAL").staticCall({ blockTag: observedBlock })
    ]);
    const account = accountRaw as readonly bigint[];
    const userBitmap = asBigInt((userConfigRaw as readonly [bigint])[0], "user configuration");
    const reserveAddresses = reservesRaw as readonly string[];
    const baseUnit = asBigInt(baseUnitRaw, "base currency unit");
    const userEModeCategory = Number(asBigInt(eModeRaw, "user eMode"));
    if (baseUnit === 0n) throw new Error("Aave returned a zero base-currency unit");
    const flashLoanPremiumBps = asBigInt(flashPremiumRaw, "flash-loan premium");
    let minBaseThreshold: bigint | null = null;
    let minLeftover: bigint | null = null;
    try {
      minBaseThreshold = asBigInt(await pool.getFunction("MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD").staticCall({ blockTag: observedBlock }), "minimum close-factor threshold");
      minLeftover = asBigInt(await pool.getFunction("MIN_LEFTOVER_BASE").staticCall({ blockTag: observedBlock }), "minimum leftover");
    } catch {
      // Older Pool implementations do not expose the V3.3 threshold getters.
    }
    let eModeData: { liquidationBonusBps: string; priceSource: string } | null = null;
    if (userEModeCategory > 0) {
      try {
        const data = await pool.getFunction("getEModeCategoryData").staticCall(userEModeCategory, { blockTag: observedBlock }) as readonly unknown[];
        eModeData = {
          liquidationBonusBps: asBigInt(data[2], "eMode liquidation bonus").toString(),
          priceSource: getAddress(String(data[3]))
        };
      } catch {
        throw new Error("User has an eMode category but this Pool does not expose its category parameters; reserve-specific liquidation estimates are withheld.");
      }
    }
    const reserves: AaveL2ReservePosition[] = [];
    for (let i = 0; i < reserveAddresses.length; i += 4) {
      const batch = reserveAddresses.slice(i, i + 4);
      const rows = await Promise.all(batch.map(async (assetRaw, j) => {
        const reserveIndex = i + j;
        const asset = getAddress(assetRaw);
        const [reserveRaw, priceRaw, decimalsRaw] = await Promise.all([
          pool.getFunction("getReserveData").staticCall(asset, { blockTag: observedBlock }),
          oracle.getFunction("getAssetPrice").staticCall(asset, { blockTag: observedBlock }),
          new Contract(asset, ERC20_ABI, provider).getFunction("decimals").staticCall({ blockTag: observedBlock })
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
          stableDebtToken === ZERO ? 0n : new Contract(stableDebtToken, ERC20_ABI, provider).getFunction("balanceOf").staticCall(borrower, { blockTag: observedBlock }),
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
          asset, symbol: asset, decimals, reserveId, eModeCategory: reserveEModeCategory,
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
    }

    const priceFor = async (asset: AaveL2ReservePosition, asCollateral: boolean): Promise<bigint> => {
      if (userEModeCategory > 0 && eModeData && eModeData.priceSource !== ZERO &&
          (!asCollateral || asset.eModeCategory === userEModeCategory)) {
        return asBigInt(await oracle.getFunction("getAssetPrice").staticCall(eModeData.priceSource, { blockTag: observedBlock }), "eMode price");
      }
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
        const bonus = userEModeCategory > 0 && eModeData && collateral.eModeCategory === userEModeCategory
          ? BigInt(eModeData.liquidationBonusBps)
          : BigInt(collateral.liquidationBonusBps);
        if (bonus <= BPS) continue;
        const collateralUnit = 10n ** BigInt(collateral.decimals);
        const debtUnit = 10n ** BigInt(debt.decimals);
        const debtBase = ceilDiv(BigInt(debt.totalDebt) * debtPrice, debtUnit);
        const collateralBase = BigInt(collateral.collateralBalance) * collateralPrice / collateralUnit;
        const totalDebtBase = asBigInt(account[1], "total debt base");
        let maxDebtBase = BigInt(debt.totalDebt) * debtPrice / debtUnit;
        const closeFactorApplies = minBaseThreshold !== null
          ? collateralBase >= minBaseThreshold && debtBase >= minBaseThreshold && hf > 95n * WAD / 100n
          : hf > 95n * WAD / 100n;
        let closeFactorBps = 10_000n;
        if (closeFactorApplies) {
          closeFactorBps = 5_000n;
          const halfAccountDebt = (totalDebtBase * 5_000n + 5_000n) / BPS;
          if (debtBase > halfAccountDebt) maxDebtBase = halfAccountDebt;
        }
        const requestedDebt = maxDebtBase * debtUnit / debtPrice;
        const baseCollateral = debtPrice * requestedDebt * collateralUnit / (collateralPrice * debtUnit);
        const maxCollateral = percentMulFloor(baseCollateral, bonus);
        let seized = maxCollateral;
        let actualDebt = requestedDebt;
        if (maxCollateral > BigInt(collateral.collateralBalance)) {
          seized = BigInt(collateral.collateralBalance);
          const debtValue = collateralPrice * seized * debtUnit / (debtPrice * collateralUnit);
          actualDebt = percentDivCeil(debtValue, bonus);
        }
        const bonusCollateral = seized - (seized * BPS / bonus);
        const protocolFee = ceilDiv(bonusCollateral * BigInt(collateral.liquidationProtocolFeeBps), BPS);
        const netCollateral = seized - protocolFee;
        const debtRemaining = BigInt(debt.totalDebt) - actualDebt;
        const collateralRemaining = BigInt(collateral.collateralBalance) - seized - protocolFee;
        const debtRemainingBase = ceilDiv(debtRemaining * debtPrice, debtUnit);
        const collateralRemainingBase = collateralRemaining * collateralPrice / collateralUnit;
        const debtFullyCleared = actualDebt >= BigInt(debt.totalDebt);
        const collateralFullyCleared = seized + protocolFee >= BigInt(collateral.collateralBalance);
        const dustSatisfied = minLeftover === null || debtFullyCleared || collateralFullyCleared ||
          (debtRemainingBase >= minLeftover && collateralRemainingBase >= minLeftover);
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
          flashLoanAvailable: flashAvailable, estimatedGrossBonusBase: grossBonusBase.toString()
        });
      }
    }
    const blockPriceSourceWarning = userEModeCategory > 0 && eModeData?.priceSource !== ZERO
      ? "eMode priceSource override was applied to debt prices and matching-category collateral prices."
      : "";
    return {
      network: args.network, chainId: deployment.chainId, pool: poolAddress, oracle: oracleAddress,
      user: borrower, observedBlock, blockTimestamp: block.timestamp,
      baseCurrency: getAddress(String(baseCurrencyRaw)), baseCurrencyUnit: baseUnit.toString(),
      totalCollateralBase: asBigInt(account[0], "total collateral base").toString(),
      totalDebtBase: asBigInt(account[1], "total debt base").toString(),
      healthFactorWad: hf.toString(), liquidationEligible: hf > 0n && hf < WAD,
      userEModeCategory, eModeCategory: eModeData, flashLoanPremiumBps: flashLoanPremiumBps.toString(),
      minBaseMaxCloseFactorThreshold: minBaseThreshold?.toString() ?? null,
      minLeftoverBase: minLeftover?.toString() ?? null, reserves, pairs,
      warnings: [
        "All Aave account, reserve, token-balance, price, eMode and flash-premium reads use one confirmed block.",
        "The calculator mirrors reserve-level debt/collateral limits and known Pool close-factor/dust getters; exact scaled-token rounding and chain-specific Pool implementation behavior must still pass fork simulation.",
        "Flash-loan liquidity is a point-in-time underlying balance and can change before execution.",
        blockPriceSourceWarning,
        "This endpoint does not sign, broadcast, or submit transactions."
      ].filter(Boolean)
    };
  } finally {
    await provider.destroy();
  }
}
