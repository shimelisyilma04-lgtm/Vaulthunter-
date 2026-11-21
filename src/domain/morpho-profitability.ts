const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000_000n;
const LIQUIDATION_CURSOR = 3n * 10n ** 17n; // 0.3 WAD
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n; // 1.15 WAD

export interface MorphoBlueEstimateInput {
  lltvWad: string;
  oraclePrice: string;
  totalBorrowAssets: string;
  totalBorrowShares: string;
  positionBorrowShares: string;
  collateralAssets: string;
  /** Optional partial repayment. Defaults to the full position share balance. */
  repaidShares?: string;
  /** All costs must be denominated in loan-token base units at the same snapshot. */
  flashLoanFee: string;
  swapAndSlippageCost: string;
  gasCost: string;
  builderFee: string;
  safetyMargin: string;
}

export interface MorphoBlueEstimate {
  eligibleByHealthCheck: boolean;
  liquidationIncentiveFactorWad: string;
  positionDebtAssets: string;
  repaidShares: string;
  repaidAssets: string;
  collateralSeizedAssets: string;
  seizedCollateralValueInLoanUnits: string;
  grossIncentiveLoanUnits: string;
  totalCostsLoanUnits: string;
  estimatedNetProfitLoanUnits: string;
  collateralSufficient: boolean;
  profitableBeforeForkSimulation: boolean;
  assumptions: string[];
  warnings: string[];
}

function uint(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 100) {
    throw new Error(name + " must be a non-negative integer string");
  }
  return BigInt(value);
}

function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("division denominator must be positive");
  return n === 0n ? 0n : (n + d - 1n) / d;
}

/**
 * Mirrors Morpho Blue's current core liquidation arithmetic for a caller-chosen
 * borrow-share repayment. It is a read-only estimate, not transaction calldata.
 * All costs are loan-token base units; oraclePrice uses Morpho's 1e36 scale.
 */
export function estimateMorphoBlueLiquidation(input: MorphoBlueEstimateInput): MorphoBlueEstimate {
  const lltv = uint(input.lltvWad, "lltvWad");
  const price = uint(input.oraclePrice, "oraclePrice");
  const totalBorrowAssets = uint(input.totalBorrowAssets, "totalBorrowAssets");
  const totalBorrowShares = uint(input.totalBorrowShares, "totalBorrowShares");
  const positionBorrowShares = uint(input.positionBorrowShares, "positionBorrowShares");
  const collateralAssets = uint(input.collateralAssets, "collateralAssets");
  const repaidShares = uint(input.repaidShares ?? input.positionBorrowShares, "repaidShares");
  const flashLoanFee = uint(input.flashLoanFee, "flashLoanFee");
  const swapCost = uint(input.swapAndSlippageCost, "swapAndSlippageCost");
  const gasCost = uint(input.gasCost, "gasCost");
  const builderFee = uint(input.builderFee, "builderFee");
  const safetyMargin = uint(input.safetyMargin, "safetyMargin");

  if (lltv >= WAD) throw new Error("lltvWad must be below 1e18");
  if (price === 0n) throw new Error("oraclePrice must be positive");
  if (positionBorrowShares === 0n || totalBorrowShares === 0n || totalBorrowAssets === 0n) {
    throw new Error("borrow position and market borrow totals must be non-zero");
  }
  if (repaidShares === 0n || repaidShares > positionBorrowShares) {
    throw new Error("repaidShares must be positive and no greater than the borrower's shares");
  }

  // Same rounding directions as Morpho Blue: health/debt conversion rounds up.
  const shareDenominator = totalBorrowShares + VIRTUAL_SHARES;
  const shareNumerator = positionBorrowShares * (totalBorrowAssets + VIRTUAL_ASSETS);
  const positionDebtAssets = ceilDiv(shareNumerator, shareDenominator);
  const maxBorrowAtLltv = (collateralAssets * price / ORACLE_PRICE_SCALE) * lltv / WAD;
  const eligibleByHealthCheck = maxBorrowAtLltv < positionDebtAssets;

  // Morpho.sol: min(1.15e18, 1e18 / (1 - 0.3 * (1 - LLTV))).
  const cursorDiscount = LIQUIDATION_CURSOR * (WAD - lltv) / WAD;
  const denominator = WAD - cursorDiscount;
  const uncappedLif = WAD * WAD / denominator;
  const lif = uncappedLif < MAX_LIQUIDATION_INCENTIVE_FACTOR
    ? uncappedLif
    : MAX_LIQUIDATION_INCENTIVE_FACTOR;

  // Morpho.sol uses toAssetsDown + wMulDown for collateral seizure, but
  // toAssetsUp for the loan-token amount actually repaid.
  const repaymentAssetsDown = repaidShares * (totalBorrowAssets + VIRTUAL_ASSETS) / shareDenominator;
  const repaidAssets = ceilDiv(repaidShares * (totalBorrowAssets + VIRTUAL_ASSETS), shareDenominator);
  const seizedValue = repaymentAssetsDown * lif / WAD;
  const collateralSeizedAssets = seizedValue * ORACLE_PRICE_SCALE / price;
  const seizedCollateralValueInLoanUnits = collateralSeizedAssets * price / ORACLE_PRICE_SCALE;
  const grossIncentive = seizedCollateralValueInLoanUnits - repaidAssets;
  const totalCosts = flashLoanFee + swapCost + gasCost + builderFee + safetyMargin;
  const estimatedNetProfit = grossIncentive - totalCosts;
  const collateralSufficient = collateralSeizedAssets <= collateralAssets;

  return {
    eligibleByHealthCheck,
    liquidationIncentiveFactorWad: lif.toString(),
    positionDebtAssets: positionDebtAssets.toString(),
    repaidShares: repaidShares.toString(),
    repaidAssets: repaidAssets.toString(),
    collateralSeizedAssets: collateralSeizedAssets.toString(),
    seizedCollateralValueInLoanUnits: seizedCollateralValueInLoanUnits.toString(),
    grossIncentiveLoanUnits: grossIncentive.toString(),
    totalCostsLoanUnits: totalCosts.toString(),
    estimatedNetProfitLoanUnits: estimatedNetProfit.toString(),
    collateralSufficient,
    profitableBeforeForkSimulation: eligibleByHealthCheck && collateralSufficient && estimatedNetProfit > 0n,
    assumptions: [
      "Market totals, borrower position, LLTV and oracle price must come from the same pinned block after interest accrual is accounted for.",
      "Morpho Blue has no fixed close factor; repaidShares selects a partial or full share repayment.",
      "Borrow-share conversions include Morpho core virtual assets (1) and virtual shares (1e6).",
      "Morpho Blue's core LIF formula and integer rounding directions are mirrored for this estimate.",
      "All cost inputs are loan-token base units; no token-decimal or USD conversion is performed."
    ],
    warnings: [
      "This pure calculator expects market totals already accrued to the supplied snapshot; its caller must source those totals using the market IRM view method and Morpho Taylor compounding at the same block timestamp.",
      "A collateral-shortfall result is not executable: Morpho's collateral subtraction would revert if seized assets exceed the position balance.",
      "Swap proceeds, flash-loan availability, gas conversion, MEV, callback correctness and state drift require separate validation.",
      "This is screening only. No transaction is signed or submitted."
    ]
  };
}
