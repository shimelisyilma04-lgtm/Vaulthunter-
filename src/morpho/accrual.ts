export const MORPHO_WAD = 10n ** 18n;

export interface MorphoAccrualInput {
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  borrowShares: bigint;
  borrowRateWadPerSecond: bigint;
  elapsedSeconds: bigint;
}

export interface MorphoAccrualResult {
  compoundedInterestWad: bigint;
  accruedInterestAssets: bigint;
  accruedTotalBorrowAssets: bigint;
  borrowerDebtAssetsUp: bigint;
}

/** Mirrors Morpho Blue MathLib.wTaylorCompounded: first three Taylor terms. */
export function morphoTaylorCompounded(rateWadPerSecond: bigint, elapsedSeconds: bigint): bigint {
  if (rateWadPerSecond < 0n || elapsedSeconds < 0n) throw new Error("Rate and elapsed time must be non-negative");
  const first = rateWadPerSecond * elapsedSeconds;
  const second = first * first / (2n * MORPHO_WAD);
  const third = second * first / (3n * MORPHO_WAD);
  return first + second + third;
}

/** Mirrors Morpho's interest accrual and shares-to-assets-up debt conversion. */
export function accrueMorphoBorrowDebt(input: MorphoAccrualInput): MorphoAccrualResult {
  const { totalBorrowAssets, totalBorrowShares, borrowShares, borrowRateWadPerSecond, elapsedSeconds } = input;
  if ([totalBorrowAssets, totalBorrowShares, borrowShares].some((v) => v < 0n)) throw new Error("Balances must be non-negative");
  if (borrowShares > 0n && totalBorrowShares === 0n) throw new Error("Borrow shares exist with zero market shares");
  const compoundedInterestWad = morphoTaylorCompounded(borrowRateWadPerSecond, elapsedSeconds);
  const accruedInterestAssets = totalBorrowAssets * compoundedInterestWad / MORPHO_WAD;
  const accruedTotalBorrowAssets = totalBorrowAssets + accruedInterestAssets;
  const borrowerDebtAssetsUp = borrowShares === 0n ? 0n :
    (borrowShares * accruedTotalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
  return { compoundedInterestWad, accruedInterestAssets, accruedTotalBorrowAssets, borrowerDebtAssetsUp };
}
