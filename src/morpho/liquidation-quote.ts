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
function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, MORPHO_WAD);
}
function wDivUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, MORPHO_WAD, y);
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
  valid: boolean;
  liquidationIncentiveFactorWad: bigint;
  borrowerDebtAssetsUp: bigint;
  maxBorrowAssets: bigint;
  requestedRepaidShares: bigint;
  repaidShares: bigint;
  repaidAssets: bigint;
  seizedAssets: bigint;
  remainingBorrowShares: bigint;
  remainingCollateralAssets: bigint;
  liquiditySufficient: boolean;
  collateralSufficient: boolean;
  repaymentSharesSufficient: boolean;
  collateralLimited: boolean;
  liquidationMode: "repaid-shares" | "seized-collateral";
}

/**
 * Mirrors Morpho Blue's liquidate() math at the supplied market state.
 * Morpho accepts exactly one of repaidShares or seizedAssets. If the
 * requested share-based seizure exceeds the borrower's collateral, this
 * quote switches to the seizedAssets branch and derives repayment shares
 * with Morpho's ceil rounding and virtual share/asset offsets.
 *
 * Callers must supply market totals, borrower position, oracle price and
 * LLTV read at the same pinned block. This is a deterministic local mirror,
 * not a substitute for a successful transaction/fork simulation.
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
  if (input.totalBorrowShares === 0n && (input.borrowerBorrowShares > 0n || input.repaidShares > 0n)) {
    throw new Error("Borrow shares exist while market total shares are zero");
  }
  if (input.totalBorrowAssets === 0n && input.totalBorrowShares > 0n) {
    throw new Error("Market has borrow shares but zero borrow assets");
  }
  if (input.repaidShares === 0n) throw new Error("Repaid shares must be positive");
  if (input.repaidShares > input.borrowerBorrowShares) throw new Error("Repaid shares exceed borrower debt shares");
  if (input.borrowerCollateralAssets === 0n) throw new Error("Borrower has no collateral to quote");

  const borrowerDebtAssetsUp = toAssetsUp(
    input.borrowerBorrowShares, input.totalBorrowAssets, input.totalBorrowShares
  );
  const collateralValue = mulDivDown(input.borrowerCollateralAssets, input.oraclePrice, ORACLE_PRICE_SCALE);
  const maxBorrowAssets = wMulDown(collateralValue, input.lltvWad);
  const liquidatable = maxBorrowAssets < borrowerDebtAssetsUp;

  // Morpho Blue: min(1.15e18, 1e18 / (1e18 - 0.3e18 * (1e18 - LLTV))).
  const cursorDiscount = wMulDown(LIQUIDATION_CURSOR, MORPHO_WAD - input.lltvWad);
  const incentiveDenominator = MORPHO_WAD - cursorDiscount;
  const uncappedIncentive = mulDivDown(MORPHO_WAD, MORPHO_WAD, incentiveDenominator);
  const liquidationIncentiveFactorWad = uncappedIncentive < MAX_LIQUIDATION_INCENTIVE_FACTOR
    ? uncappedIncentive : MAX_LIQUIDATION_INCENTIVE_FACTOR;

  const requestedRepayAssetsDown = toAssetsDown(
    input.repaidShares, input.totalBorrowAssets, input.totalBorrowShares
  );
  const requestedSeizedAssets = mulDivDown(
    wMulDown(requestedRepayAssetsDown, liquidationIncentiveFactorWad),
    ORACLE_PRICE_SCALE,
    input.oraclePrice
  );

  let liquidationMode: MorphoLiquidationQuote["liquidationMode"] = "repaid-shares";
  let repaidShares = input.repaidShares;
  let seizedAssets = requestedSeizedAssets;

  if (requestedSeizedAssets > input.borrowerCollateralAssets) {
    // Morpho's seizedAssets branch: quote collateral value UP, divide by LIF
    // UP, then convert assets to shares UP. This avoids requesting an
    // impossible collateral transfer and mirrors the contract's rounding.
    liquidationMode = "seized-collateral";
    seizedAssets = input.borrowerCollateralAssets;
    const seizedAssetsQuoted = mulDivUp(seizedAssets, input.oraclePrice, ORACLE_PRICE_SCALE);
    const repayAssetsQuoted = wDivUp(seizedAssetsQuoted, liquidationIncentiveFactorWad);
    repaidShares = toSharesUp(repayAssetsQuoted, input.totalBorrowAssets, input.totalBorrowShares);
  }

  const repaymentSharesSufficient = repaidShares <= input.borrowerBorrowShares;
  const valid = repaymentSharesSufficient && seizedAssets <= input.borrowerCollateralAssets;
  const safeRepaidShares = repaymentSharesSufficient ? repaidShares : input.borrowerBorrowShares;
  const repaidAssets = toAssetsUp(safeRepaidShares, input.totalBorrowAssets, input.totalBorrowShares);

  return {
    liquidatable,
    valid,
    liquidationIncentiveFactorWad,
    borrowerDebtAssetsUp,
    maxBorrowAssets,
    requestedRepaidShares: input.repaidShares,
    repaidShares,
    repaidAssets,
    seizedAssets,
    remainingBorrowShares: input.borrowerBorrowShares - safeRepaidShares,
    remainingCollateralAssets: input.borrowerCollateralAssets - seizedAssets,
    liquiditySufficient: repaidAssets <= input.availableLoanLiquidity,
    collateralSufficient: valid && seizedAssets <= input.borrowerCollateralAssets,
    repaymentSharesSufficient,
    collateralLimited: liquidationMode === "seized-collateral",
    liquidationMode
  };
}
