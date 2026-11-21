import { Contract, JsonRpcProvider } from "ethers";
import { getAaveL2FlashLoanTerms } from "../aave/l2-reserve-positions.js";
import { quoteMultiChainUniswapV3 } from "../chain/uniswap-v3-quote.js";
import type { MorphoPositionSnapshot } from "./blue.js";
import { estimateMorphoBlueLiquidation } from "../domain/morpho-profitability.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const ERC20_ABI = ["function decimals() view returns (uint8)"] as const;
function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("Denominator must be positive");
  return n === 0n ? 0n : (n + d - 1n) / d;
}
function unsigned(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) throw new Error(label + " must be an unsigned integer string");
  return BigInt(value);
}
function validateBps(value: number, label: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value >= 10_000) throw new Error(label + " must be 0-9999 bps");
  return BigInt(value);
}

/**
 * Live read-only Morpho opportunity screen. Debt is accrued using the market's
 * IRM at the snapshot block; collateral is quoted directly into the loan token;
 * Aave flash-loan liquidity/premium and RPC gas price are included as budgets.
 */
export async function estimateMorphoBlueLiveProfitability(args: {
  snapshot: MorphoPositionSnapshot;
  network: "base" | "arbitrum";
  rpcUrl: string;
  gasUnits: string;
  slippageBps: number;
  mevBudgetBps: number;
  builderFeeBps: number;
  safetyBufferBps: number;
}): Promise<Record<string, unknown>> {
  const snapshot = args.snapshot;
  const gasUnits = unsigned(args.gasUnits, "gasUnits");
  const slippageBps = validateBps(args.slippageBps, "slippageBps");
  const mevBps = validateBps(args.mevBudgetBps, "mevBudgetBps");
  const builderBps = validateBps(args.builderFeeBps, "builderFeeBps");
  const safetyBps = validateBps(args.safetyBufferBps, "safetyBufferBps");
  if (snapshot.observedBlock < 1 || snapshot.accrualTimestamp < 1) {
    throw new Error("Morpho snapshot is missing its pinned block/accrual timestamp");
  }
  const baseEstimate = estimateMorphoBlueLiquidation({
    lltvWad: snapshot.lltvWad,
    oraclePrice: snapshot.oraclePrice,
    totalBorrowAssets: snapshot.accruedTotalBorrowAssets,
    totalBorrowShares: snapshot.totalBorrowShares,
    positionBorrowShares: snapshot.borrowShares,
    collateralAssets: snapshot.collateralAssets,
    flashLoanFee: "0", swapAndSlippageCost: "0", gasCost: "0", builderFee: "0", safetyMargin: "0"
  });
  if (!baseEstimate.eligibleByHealthCheck || !baseEstimate.collateralSufficient) {
    return {
      ...baseEstimate, network: args.network, marketId: snapshot.marketId,
      borrower: snapshot.borrower, observedBlock: snapshot.observedBlock,
      positiveAfterAllBudgets: false,
      reason: !baseEstimate.eligibleByHealthCheck ? "Morpho health check is healthy at the pinned block." : "Required collateral seizure exceeds available collateral."
    };
  }
  const provider = new JsonRpcProvider(args.rpcUrl);
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(snapshot.chainId)) throw new Error("Morpho quote RPC chain differs from the position snapshot");
    const collateralDecimals = Number(await new Contract(snapshot.collateralToken, ERC20_ABI, provider)
      .getFunction("decimals").staticCall({ blockTag: snapshot.observedBlock }));
    const loanDecimals = Number(await new Contract(snapshot.loanToken, ERC20_ABI, provider)
      .getFunction("decimals").staticCall({ blockTag: snapshot.observedBlock }));
    const flash = await getAaveL2FlashLoanTerms({
      network: args.network, rpcUrl: args.rpcUrl, asset: snapshot.loanToken, blockNumber: snapshot.observedBlock
    });
    const repayment = unsigned(baseEstimate.repaidAssets, "repaidAssets");
    const flashFee = ceilDiv(repayment * unsigned(flash.flashLoanPremiumBps, "flashLoanPremiumBps"), BPS);
    const flashLoanAvailable = flash.flashLoanEnabled && unsigned(flash.availableLiquidity, "availableLiquidity") >= repayment;
    const quote = await quoteMultiChainUniswapV3({
      network: args.network, rpcUrl: args.rpcUrl,
      tokenIn: snapshot.collateralToken, tokenOut: snapshot.loanToken,
      amountIn: baseEstimate.collateralSeizedAssets, blockNumber: snapshot.observedBlock
    });
    if (quote.amountOut === null) {
      return {
        ...baseEstimate, network: args.network, marketId: snapshot.marketId,
        borrower: snapshot.borrower, observedBlock: snapshot.observedBlock,
        quote: null, flashLoanAvailable, positiveAfterAllBudgets: false,
        warnings: ["No direct Uniswap V3 pool returned a quote. Multi-hop routing is not yet included."]
      };
    }
    const quotedOut = unsigned(quote.amountOut, "quote amount out");
    const haircutOut = quotedOut * (BPS - slippageBps) / BPS;
    const slippageHaircut = quotedOut - haircutOut;
    const debtUnit = 10n ** BigInt(loanDecimals);
    const debtPrice = unsigned(flash.assetPriceBase, "loan token oracle price");
    const nativePrice = unsigned(flash.nativePriceBase, "native token oracle price");
    if (debtPrice === 0n) throw new Error("Aave oracle returned zero loan-token price");
    const gasCostBase = ceilDiv(gasUnits * unsigned(flash.maxFeePerGasWei, "maxFeePerGasWei") * nativePrice, WAD);
    const gasCostLoanUnits = ceilDiv(gasCostBase * debtUnit, debtPrice);
    const grossAfterRepayment = haircutOut > repayment ? haircutOut - repayment : 0n;
    const mevBudget = ceilDiv(repayment * mevBps, BPS);
    const builderFee = ceilDiv(repayment * builderBps, BPS);
    const safetyBuffer = ceilDiv(grossAfterRepayment * safetyBps, BPS);
    const net = haircutOut - repayment - flashFee - gasCostLoanUnits - mevBudget - builderFee - safetyBuffer;
    return {
      network: args.network, protocol: "morpho-blue", marketId: snapshot.marketId,
      borrower: snapshot.borrower, observedBlock: snapshot.observedBlock,
      accruedAtTimestamp: snapshot.accrualTimestamp, elapsedSeconds: snapshot.elapsedSeconds,
      borrowRatePerSecondWad: snapshot.borrowRatePerSecondWad,
      positionDebtAssets: baseEstimate.positionDebtAssets,
      repaidShares: baseEstimate.repaidShares, repaidAssets: baseEstimate.repaidAssets,
      collateralSeizedAssets: baseEstimate.collateralSeizedAssets,
      collateralDecimals, loanTokenDecimals: loanDecimals,
      quote: { amountOut: quote.amountOut, feeTier: quote.selectedFee, blockNumber: quote.blockNumber },
      flashLoan: { provider: "Aave V3", premiumBps: flash.flashLoanPremiumBps, availableLiquidity: flash.availableLiquidity, available: flashLoanAvailable },
      costs: {
        flashLoanFeeLoanUnits: flashFee.toString(), gasCostLoanUnits: gasCostLoanUnits.toString(),
        slippageHaircutLoanUnits: slippageHaircut.toString(), mevBudgetLoanUnits: mevBudget.toString(),
        builderFeeLoanUnits: builderFee.toString(), safetyBufferLoanUnits: safetyBuffer.toString()
      },
      estimatedNetProfitLoanUnits: net.toString(),
      positiveAfterAllBudgets: net > 0n && flashLoanAvailable,
      source: "morpho-accrued-at-pinned-block-plus-aave-flashloan-terms-plus-same-block-uniswap-v3-quote",
      executionEnabled: false,
      transactionSubmitted: false,
      warnings: [
        "Only a direct Uniswap V3 pool is quoted; multi-hop route discovery is not included.",
        "gasUnits is caller-supplied because there is no reviewed flash-loan executor to measure end-to-end gas.",
        "Aave flash liquidity, gas price, oracle prices, and DEX liquidity can change before any transaction.",
        "MEV, builder, slippage and safety amounts are explicit stress budgets, not guarantees.",
        "Morpho interest accrual follows the IRM borrowRate and Taylor compounding formula at the pinned block; complete transaction-level fork simulation remains mandatory."
      ]
    };
  } finally {
    await provider.destroy();
  }
}
