import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { config } from "../config.js";
import { accrueMorphoBorrowDebt } from "./accrual.js";
import { quoteMorphoLiquidation } from "./liquidation-quote.js";
import type { MorphoStorePort } from "./store-port.js";
import { quoteUniswapV3BestRoute } from "../aave/uniswap-quote.js";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVE_POOL_ABI = [
  "function getReserveData(address asset) view returns (tuple(uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function getConfiguration(address asset) view returns (uint256 data)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"
];
const MORPHO_ABI = [
  "function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)"
];
const ORACLE_ABI = ["function price() view returns (uint256)"];
const IRM_ABI = ["function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns (uint256)"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"];
const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 36n;

// Skip uneconomic dust before spending RPC calls on DEX routing.
// Thresholds are denominated in each token's smallest units.
const MIN_STABLE_DEBT: Record<string, bigint> = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 10_000_000n, // 10 USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 10_000_000n, // 10 USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f": 10n * 10n ** 18n // 10 DAI
};

export async function evaluateMorphoOpportunities(store: MorphoStorePort, limit: number): Promise<Record<string, unknown>> {
  if (!config.MORPHO_RPC_URL) {
    return { status: "unavailable", reason: "MORPHO_RPC_URL is not configured", data: [], executionEnabled: false };
  }
  const provider = new JsonRpcProvider(config.MORPHO_RPC_URL, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) throw new Error("Opportunity validation requires Ethereum mainnet RPC");
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    if (!block?.hash) throw new Error("Unable to load validation block hash");
    const validationBlockHash = block.hash;
    // Scan a wider risk-ranked window so recently safe positions do not hide
    // other currently liquidatable borrowers near the top of the shortlist.
    const candidateScanLimit = Math.max(50, Math.min(100, limit * 5));
    const candidates = await store.listRiskPositions(1, candidateScanLimit);
    const morpho = new Contract(MORPHO, MORPHO_ABI, provider);
    const markets = new Map<string, Promise<any>>();
    const data: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      const reasons: string[] = [];
      try {
        const snapshotAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(candidate.snapshotUpdatedAt)) / 1000));
        if (!Number.isFinite(snapshotAgeSeconds) || snapshotAgeSeconds > 60) {
          data.push({ borrower: candidate.borrower, marketId: candidate.marketId, status: "rejected", reasons: ["Stored risk snapshot is stale"], snapshotAgeSeconds });
          continue;
        }
        let marketPromise = markets.get(candidate.marketId);
        if (!marketPromise) {
          marketPromise = Promise.all([
            morpho.getFunction("market")(candidate.marketId, { blockTag: blockNumber }),
            morpho.getFunction("idToMarketParams")(candidate.marketId, { blockTag: blockNumber })
          ]);
          markets.set(candidate.marketId, marketPromise);
        }
        const [market, params] = await marketPromise as [readonly bigint[], readonly unknown[]];
        const loanToken = getAddress(String(params[0]));
        const collateralToken = getAddress(String(params[1]));
        const oracleAddress = getAddress(String(params[2]));
        const irmAddress = getAddress(String(params[3]));
        const lltv = BigInt(params[4] as bigint);
        if (lltv.toString() !== BigInt(candidate.lltvWad).toString()) throw new Error("Market LLTV differs from stored snapshot");
        const position = await morpho.getFunction("position")(candidate.marketId, candidate.borrower, { blockTag: blockNumber }) as readonly bigint[];
        const borrowShares = BigInt(position[1] ?? 0n);
        const collateralAssets = BigInt(position[2] ?? 0n);
        if (borrowShares === 0n || collateralAssets === 0n) {
          data.push({ borrower: candidate.borrower, marketId: candidate.marketId, status: "rejected", reasons: ["Position is now closed or has no collateral"], validationBlock: blockNumber });
          continue;
        }
        const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);
        const price = BigInt(await oracle.getFunction("price")({ blockTag: blockNumber }));
        if (price <= 0n) throw new Error("Oracle returned a zero price");
        const marketState = {
          totalSupplyAssets: BigInt(market[0] ?? 0n), totalSupplyShares: BigInt(market[1] ?? 0n),
          totalBorrowAssets: BigInt(market[2] ?? 0n), totalBorrowShares: BigInt(market[3] ?? 0n),
          lastUpdate: BigInt(market[4] ?? 0n), fee: BigInt(market[5] ?? 0n)
        };
        const elapsed = BigInt(block.timestamp) - marketState.lastUpdate;
        if (elapsed < 0n) throw new Error("Market lastUpdate is later than validation block timestamp");
        const rate = marketState.totalBorrowShares === 0n || irmAddress === "0x0000000000000000000000000000000000000000"
          ? 0n
          : BigInt(await new Contract(irmAddress, IRM_ABI, provider).getFunction("borrowRateView")({
              loanToken, collateralToken, oracle: oracleAddress, irm: irmAddress, lltv
            }, marketState, { blockTag: blockNumber }));
        const debt = accrueMorphoBorrowDebt({
          totalBorrowAssets: marketState.totalBorrowAssets,
          totalBorrowShares: marketState.totalBorrowShares,
          borrowShares,
          borrowRateWadPerSecond: rate,
          elapsedSeconds: elapsed
        });
        const debtAssets = debt.borrowerDebtAssetsUp;
        const minimumStableDebt = MIN_STABLE_DEBT[loanToken.toLowerCase()];
        if (minimumStableDebt !== undefined && debtAssets < minimumStableDebt) {
          data.push({
            borrower: candidate.borrower, marketId: candidate.marketId, status: "rejected",
            reasons: ["Stablecoin debt is below the $10 minimum notional filter; skipped expensive DEX route checks"],
            validationBlock: blockNumber, validationBlockHash,
            debtAssets: debtAssets.toString(), loanToken: loanToken,
            minimumDebtAssets: minimumStableDebt.toString(), executionEnabled: false
          });
          continue;
        }
        const collateralValue = collateralAssets * price / PRICE_SCALE;
        const healthFactorWad = debtAssets === 0n ? 2n ** 255n : collateralValue * lltv / debtAssets;
        const availableMarketLiquidity = marketState.totalSupplyAssets > marketState.totalBorrowAssets
          ? marketState.totalSupplyAssets - marketState.totalBorrowAssets : 0n;
        const quote = quoteMorphoLiquidation({
          totalBorrowAssets: debt.accruedTotalBorrowAssets,
          totalBorrowShares: marketState.totalBorrowShares,
          borrowerBorrowShares: borrowShares,
          borrowerCollateralAssets: collateralAssets,
          oraclePrice: price,
          lltvWad: lltv,
          repaidShares: borrowShares,
          availableLoanLiquidity: availableMarketLiquidity
        });
        if (!quote.liquidatable || healthFactorWad >= WAD) {
          data.push({ borrower: candidate.borrower, marketId: candidate.marketId, status: "rejected", reasons: ["Position is not currently liquidatable at validation block"], validationBlock: blockNumber, healthFactor: Number(healthFactorWad) / 1e18 });
          continue;
        }
        if (!quote.valid || !quote.collateralSufficient || !quote.repaymentSharesSufficient) {
          data.push({
            borrower: candidate.borrower, marketId: candidate.marketId, status: "rejected",
            reasons: ["Morpho liquidation sizing failed collateral or repayment-share safety checks"],
            validationBlock: blockNumber, validationBlockHash: validationBlockHash,
            liquidationMath: {
              mode: quote.liquidationMode,
              collateralLimited: quote.collateralLimited,
              estimatedSeizedCollateral: quote.seizedAssets.toString(),
              borrowerCollateralAssets: collateralAssets.toString(),
              estimatedRepaidShares: quote.repaidShares.toString(),
              borrowerBorrowShares: borrowShares.toString(),
              collateralSufficient: quote.collateralSufficient,
              repaymentSharesSufficient: quote.repaymentSharesSufficient
            },
            executionEnabled: false
          });
          continue;
        }
        const [loanMeta, collateralMeta] = await Promise.all([
          new Contract(loanToken, ERC20_ABI, provider).getFunction("decimals")({ blockTag: blockNumber }),
          new Contract(collateralToken, ERC20_ABI, provider).getFunction("decimals")({ blockTag: blockNumber })
        ]);
        const [loanSymbol, collateralSymbol] = await Promise.all([
          new Contract(loanToken, ERC20_ABI, provider).getFunction("symbol")({ blockTag: blockNumber }).catch(() => "loan token"),
          new Contract(collateralToken, ERC20_ABI, provider).getFunction("symbol")({ blockTag: blockNumber }).catch(() => "collateral token")
        ]);
        const marketLiquiditySufficient = quote.repaidAssets <= availableMarketLiquidity;
        let swapQuote: Record<string, unknown> | null = null;
        try {
          const result = await quoteUniswapV3BestRoute(config.MORPHO_RPC_URL, {
            tokenIn: collateralToken, tokenOut: loanToken, amountIn: quote.seizedAssets.toString()
          }, blockNumber);
          swapQuote = result as unknown as Record<string, unknown>;
          if (result.amountOut === null || BigInt(result.amountOut) <= 0n) reasons.push("No supported direct or two-hop Uniswap V3 route returned positive output");
          if (result.blockNumber !== blockNumber || result.blockHash.toLowerCase() !== validationBlockHash.toLowerCase()) {
            reasons.push("Swap quote block hash differs from the pinned liquidation validation block");
            swapQuote = null;
          }
        } catch (error) {
          reasons.push("Collateral exit quote unavailable: " + (error instanceof Error ? error.message.slice(0, 180) : "unknown quote error"));
        }
        let flashFunding: Record<string, unknown> = { status: "unverified", provider: "Aave V3 Ethereum", availableAssets: null, premiumBps: null, estimatedFeeAssets: null };
        try {
          const aave = new Contract(AAVE_V3_POOL, AAVE_POOL_ABI, provider);
          const [reserve, configuration, premiumRaw] = await Promise.all([
            aave.getFunction("getReserveData")(loanToken, { blockTag: blockNumber }),
            aave.getFunction("getConfiguration")(loanToken, { blockTag: blockNumber }),
            aave.getFunction("FLASHLOAN_PREMIUM_TOTAL")({ blockTag: blockNumber })
          ]) as [readonly unknown[], bigint, bigint];
          const reserveConfig = BigInt(configuration as bigint);
          const active = ((reserveConfig >> 56n) & 1n) === 1n;
          const paused = ((reserveConfig >> 60n) & 1n) === 1n;
          const flashLoanEnabled = ((reserveConfig >> 63n) & 1n) === 1n;
          const aTokenAddress = getAddress(String(reserve[8]));
          const reserveBalance = BigInt(await new Contract(loanToken, ERC20_ABI, provider).getFunction("balanceOf")(aTokenAddress, { blockTag: blockNumber }));
          const premiumBps = BigInt(premiumRaw as bigint);
          const estimatedFeeAssets = quote.repaidAssets * premiumBps / 10000n;
          const available = active && !paused && flashLoanEnabled && reserveBalance >= quote.repaidAssets;
          flashFunding = {
            status: available ? "reserve-liquidity-verified-at-snapshot" : "unavailable-or-insufficient",
            provider: "Aave V3 Ethereum flashLoanSimple reserve",
            aTokenAddress, reserveAvailableAssets: reserveBalance.toString(),
            requiredAssets: quote.repaidAssets.toString(), sufficient: available,
            premiumBps: premiumBps.toString(), estimatedFeeAssets: estimatedFeeAssets.toString()
          };
          if (!available) reasons.push("Aave V3 reserve is inactive, paused, flash-loan-disabled, or has insufficient liquidity");
        } catch (error) {
          reasons.push("Aave V3 flash-loan reserve could not be verified: " + (error instanceof Error ? error.message.slice(0, 160) : "unknown error"));
        }
        reasons.push("Gas cost cannot yet be converted into the loan-token denomination");
        reasons.push("A single-pool quote is not a full transaction simulation");
        const marketLiquidity = {
          availableLoanAssets: availableMarketLiquidity.toString(),
          requiredRepaymentAssets: quote.repaidAssets.toString(),
          sufficientForRepayment: marketLiquiditySufficient,
          meaning: "Market withdrawal liquidity only; it is not the liquidator's funding"
        };
        data.push({
          borrower: candidate.borrower, marketId: candidate.marketId,
          status: marketLiquiditySufficient && swapQuote && typeof swapQuote.amountOut === "string" && BigInt(swapQuote.amountOut) > 0n ? "partially-validated" : "not-validated",
          validationBlock: blockNumber, validationBlockHash: validationBlockHash,
          healthFactor: Number(healthFactorWad) / 1e18,
          loanToken: { address: loanToken, symbol: String(loanSymbol), decimals: Number(loanMeta) },
          collateralToken: { address: collateralToken, symbol: String(collateralSymbol), decimals: Number(collateralMeta) },
          debtAssets: debtAssets.toString(), collateralAssets: collateralAssets.toString(),
          liquidationIncentiveFactor: Number(quote.liquidationIncentiveFactorWad) / 1e18,
          estimatedRepaidAssets: quote.repaidAssets.toString(),
          estimatedRepaidShares: quote.repaidShares.toString(),
          estimatedSeizedCollateral: quote.seizedAssets.toString(),
          liquidationMath: {
            source: "Morpho Blue liquidate() integer rounding mirrored locally",
            validationBlock: blockNumber,
            validationBlockHash: validationBlockHash,
            mode: quote.liquidationMode,
            collateralLimited: quote.collateralLimited,
            requestedRepaidShares: quote.requestedRepaidShares.toString(),
            actualRepaidShares: quote.repaidShares.toString(),
            collateralSufficient: quote.collateralSufficient,
            repaymentSharesSufficient: quote.repaymentSharesSufficient,
            remainingBorrowShares: quote.remainingBorrowShares.toString(),
            remainingCollateralAssets: quote.remainingCollateralAssets.toString(),
            note: "All market, position, LLTV and oracle inputs were read at this validation block. Local formula parity is not a successful transaction simulation."
          },
          marketLiquidity, collateralExitQuote: swapQuote,
          funding: flashFunding,
          gas: { status: "unpriced", gasUnitsFromQuote: swapQuote?.gasEstimate ?? null, gasPriceWei: (await provider.getFeeData()).gasPrice?.toString() ?? null },
          profitability: {
            status: "pre-gas-estimate-only",
            grossSwapOutputLoanToken: swapQuote?.amountOut ?? null,
            estimatedFlashLoanFeeLoanToken: flashFunding.estimatedFeeAssets ?? null,
            preGasProfitLoanToken: typeof swapQuote?.amountOut === "string" && typeof flashFunding.estimatedFeeAssets === "string"
              ? (BigInt(swapQuote.amountOut) - quote.repaidAssets - BigInt(flashFunding.estimatedFeeAssets)).toString() : null,
            netProfitLoanToken: null, reasons
          },
          reasons, executionEnabled: false, transactionSubmitted: false
        });
      } catch (error) {
        data.push({ borrower: candidate.borrower, marketId: candidate.marketId, status: "error", validationBlock: blockNumber, reasons: [error instanceof Error ? error.message.slice(0, 300) : "Opportunity validation failed"] });
      }
    }
    return {
      protocol: "morpho-blue", chain: "ethereum", chainId: 1,
      status: data.length === 0 ? "no-fresh-risk-positions" : data.some((row) => row.status === "partially-validated") ? "partial-validation-only" : "no-validated-opportunities",
      validationBlock: blockNumber, validationBlockHash: validationBlockHash,
      candidatesChecked: data.length, candidateScanLimit, data,
      definition: "Partially validated means current liquidation eligibility, Morpho quote, market liquidity and a DEX quote were checked. It does not mean liquidator funding or net profitability is verified.",
      executionEnabled: false, transactionSigningEnabled: false, transactionSubmissionEnabled: false
    };
  } finally {
    await provider.destroy();
  }
}
