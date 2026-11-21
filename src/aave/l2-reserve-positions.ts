import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "./l2-readonly.js";
import { quoteMultiChainUniswapV3 } from "../chain/uniswap-v3-quote.js";

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
        const dustSatisfied = minLeftover !== null && (debtFullyCleared || collateralFullyCleared ||
          (debtRemainingBase >= minLeftover && collateralRemainingBase >= minLeftover));
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
    const haircutOut = quotedOut * (BPS - slippageBps) / BPS;
    const slippageHaircut = quotedOut - haircutOut;
    const debtToCover = uint(input.pair.actualDebtToCover, "actualDebtToCover");
    const grossAfterRepayment = haircutOut > debtToCover ? haircutOut - debtToCover : 0n;
    const safetyBuffer = ceil(grossAfterRepayment * safetyBps, BPS);
    const net = haircutOut - debtToCover - flashFee - gasCostDebtUnits -
      mevBudget - builderFee - safetyBuffer;
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
