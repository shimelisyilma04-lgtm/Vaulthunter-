import { MORPHO_WAD } from "./accrual.js";

const ORACLE_PRICE_SCALE = 10n ** 36n;
const LIQUIDATION_CURSOR = 3n * 10n ** 17n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n;
const VIRTUAL_ASSETS = 1n;
const VIRTUAL_SHARES = 1_000_000n;

function mulDivDown(x: bigint, y: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Denominator must be positive");
  return (x * y) / denominator;
}
function mulDivUp(x: bigint, y: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Denominator must be positive");
  return (x * y + denominator - 1n) / denominator;
}
function toAssetsDown(shares: bigint, assets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, assets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
function toAssetsUp(shares: bigint, assets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, assets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

export interface MorphoLiquidationQuoteInput {
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  borrowerBorrowShares: bigint;
  borrowerCollateralAssets: bigint;
  oraclePrice: bigint;
  lltvWad: bigint;
  repaidShares: bigint;
  availableLoanLiquidity: bigint;
}

export interface MorphoLiquidationQuote {
  liquidatable: boolean;
  liquidationIncentiveFactorWad: bigint;
  borrowerDebtAssetsUp: bigint;
  maxBorrowAssets: bigint;
  repaidAssets: bigint;
  seizedAssets: bigint;
  remainingBorrowShares: bigint;
  remainingCollateralAssets: bigint;
  liquiditySufficient: boolean;
  collateralSufficient: boolean;
}

/**
 * Reproduces Morpho Blue's liquidation math for the repaidShares input branch.
 * This is a local quote only: it does not replace a pinned-block eth_call.
 */
export function quoteMorphoLiquidation(input: MorphoLiquidationQuoteInput): MorphoLiquidationQuote {
  const values = [
    input.totalBorrowAssets, input.totalBorrowShares, input.borrowerBorrowShares,
    input.borrowerCollateralAssets, input.oraclePrice, input.lltvWad,
    input.repaidShares, input.availableLoanLiquidity
  ];
  if (values.some((value) => value < 0n)) throw new Error("Liquidation quote inputs must be non-negative");
  if (input.oraclePrice === 0n) throw new Error("Oracle price must be positive");
  if (input.lltvWad <= 0n || input.lltvWad >= MORPHO_WAD) throw new Error("LLTV must be between zero and WAD");
  if (input.totalBorrowShares === 0n && input.borrowerBorrowShares > 0n) {
    throw new Error("Borrower has shares while market total shares are zero");
  }
  if (input.repaidShares === 0n) throw new Error("Repaid shares must be positive");
  if (input.repaidShares > input.borrowerBorrowShares) throw new Error("Repaid shares exceed borrower debt shares");

  const borrowerDebtAssetsUp = toAssetsUp(
    input.borrowerBorrowShares, input.totalBorrowAssets, input.totalBorrowShares
  );
  const collateralValue = mulDivDown(input.borrowerCollateralAssets, input.oraclePrice, ORACLE_PRICE_SCALE);
  const maxBorrowAssets = mulDivDown(collateralValue, input.lltvWad, MORPHO_WAD);
  const liquidatable = maxBorrowAssets < borrowerDebtAssetsUp;

  const cursorDiscount = mulDivDown(LIQUIDATION_CURSOR, MORPHO_WAD - input.lltvWad, MORPHO_WAD);
  const incentiveDenominator = MORPHO_WAD - cursorDiscount;
  const uncappedIncentive = mulDivDown(MORPHO_WAD, MORPHO_WAD, incentiveDenominator);
  const liquidationIncentiveFactorWad = uncappedIncentive < MAX_LIQUIDATION_INCENTIVE_FACTOR
    ? uncappedIncentive : MAX_LIQUIDATION_INCENTIVE_FACTOR;

  const repayAssetsDown = toAssetsDown(input.repaidShares, input.totalBorrowAssets, input.totalBorrowShares);
  const incentiveAdjustedRepay = mulDivDown(repayAssetsDown, liquidationIncentiveFactorWad, MORPHO_WAD);
  const seizedAssets = mulDivDown(incentiveAdjustedRepay, ORACLE_PRICE_SCALE, input.oraclePrice);
  const repaidAssets = toAssetsUp(input.repaidShares, input.totalBorrowAssets, input.totalBorrowShares);
  const remainingCollateralAssets = input.borrowerCollateralAssets - (seizedAssets <= input.borrowerCollateralAssets ? seizedAssets : input.borrowerCollateralAssets);

  return {
    liquidatable,
    liquidationIncentiveFactorWad,
    borrowerDebtAssetsUp,
    maxBorrowAssets,
    repaidAssets,
    seizedAssets,
    remainingBorrowShares: input.borrowerBorrowShares - input.repaidShares,
    remainingCollateralAssets,
    liquiditySufficient: repaidAssets <= input.availableLoanLiquidity,
    collateralSufficient: seizedAssets <= input.borrowerCollateralAssets
  };
}
