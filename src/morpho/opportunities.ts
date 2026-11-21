import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { config } from "../config.js";
import { accrueMorphoBorrowDebt } from "./accrual.js";
import { quoteMorphoLiquidation } from "./liquidation-quote.js";
import type { MorphoStorePort } from "./store-port.js";
import { quoteUniswapV3BestExactInput } from "../aave/uniswap-quote.js";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_ABI = [
  "function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)"
];
const ORACLE_ABI = ["function price() view returns (uint256)"];
const IRM_ABI = ["function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee) market) view returns (uint256)"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 36n;

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
    if (!block) throw new Error("Unable to load validation block");
    const candidates = await store.listRiskPositions(1, Math.max(1, Math.min(20, limit)));
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
          const result = await quoteUniswapV3BestExactInput(config.MORPHO_RPC_URL, {
            tokenIn: collateralToken, tokenOut: loanToken, amountIn: quote.seizedAssets.toString()
          });
          swapQuote = result as unknown as Record<string, unknown>;
          if (result.amountOut === null) reasons.push("No supported Uniswap V3 fee-tier route returned a quote");
          if (result.blockNumber !== blockNumber) reasons.push("Swap quote is from a different block; cross-check is not atomic");
        } catch (error) {
          reasons.push("Collateral exit quote unavailable: " + (error instanceof Error ? error.message.slice(0, 180) : "unknown quote error"));
        }
        reasons.push("Liquidator funding source is not configured or independently verified");
        reasons.push("Flash-loan availability and fee are not verified");
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
          status: marketLiquiditySufficient && swapQuote && swapQuote.amountOut !== null ? "partially-validated" : "not-validated",
          validationBlock: blockNumber, validationBlockHash: block.hash,
          healthFactor: Number(healthFactorWad) / 1e18,
          loanToken: { address: loanToken, symbol: String(loanSymbol), decimals: Number(loanMeta) },
          collateralToken: { address: collateralToken, symbol: String(collateralSymbol), decimals: Number(collateralMeta) },
          debtAssets: debtAssets.toString(), collateralAssets: collateralAssets.toString(),
          liquidationIncentiveFactor: Number(quote.liquidationIncentiveFactorWad) / 1e18,
          estimatedRepaidAssets: quote.repaidAssets.toString(),
          estimatedSeizedCollateral: quote.seizedAssets.toString(),
          marketLiquidity, collateralExitQuote: swapQuote,
          funding: { status: "unverified", provider: null, flashLoanFee: null },
          gas: { status: "unpriced", gasUnitsFromQuote: swapQuote?.gasEstimate ?? null, gasPriceWei: (await provider.getFeeData()).gasPrice?.toString() ?? null },
          profitability: { status: "not-computable", grossSwapOutputLoanToken: swapQuote?.amountOut ?? null, netProfitLoanToken: null, reasons },
          reasons, executionEnabled: false, transactionSubmitted: false
        });
      } catch (error) {
        data.push({ borrower: candidate.borrower, marketId: candidate.marketId, status: "error", validationBlock: blockNumber, reasons: [error instanceof Error ? error.message.slice(0, 300) : "Opportunity validation failed"] });
      }
    }
    return {
      protocol: "morpho-blue", chain: "ethereum", chainId: 1,
      status: data.length === 0 ? "no-fresh-risk-positions" : data.some((row) => row.status === "partially-validated") ? "partial-validation-only" : "no-validated-opportunities",
      validationBlock: blockNumber, validationBlockHash: block.hash,
      candidatesChecked: data.length, data,
      definition: "Partially validated means current liquidation eligibility, Morpho quote, market liquidity and a DEX quote were checked. It does not mean liquidator funding or net profitability is verified.",
      executionEnabled: false, transactionSigningEnabled: false, transactionSubmissionEnabled: false
    };
  } finally {
    await provider.destroy();
  }
}
