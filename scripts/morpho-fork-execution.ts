import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  getAddress
} from "ethers";
import { quoteUniswapV3BestRoute } from "../src/aave/uniswap-quote.js";

const UPSTREAM_RPC = process.env.ETHEREUM_FORK_UPSTREAM_RPC_URL;
const OPPORTUNITIES_URL = process.env.VAULTHUNTER_OPPORTUNITIES_URL ??
  "https://vaulthunter-core.onrender.com/api/v1/morpho/opportunities?limit=20";
const LOCAL_RPC = "http://127.0.0.1:8545";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
// Public Anvil development key; it is only valid on the disposable local fork.
const ANVIL_TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type Candidate = {
  borrower: string;
  marketId: string;
  validationBlock: number;
  validationBlockHash: string;
  marketParams: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string };
  oraclePrice: string;
  debtAssets: string;
  collateralAssets: string;
  estimatedRepaidAssets: string;
  estimatedRepaidShares: string;
  estimatedSeizedCollateral: string;
  liquidationMath: { mode: string };
  collateralExitQuote: { amountOut: string | null; swapPath?: string | null; routeType?: string };
  status: string;
};

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function waitForFork(provider: JsonRpcProvider, child: ChildProcessWithoutNullStreams): Promise<void> {
  let lastError = "Anvil has not responded";
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error("Anvil exited before becoming ready: " + lastError);
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== 31337n) throw new Error("Local fork did not report chain ID 31337");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Timed out waiting for Anvil: " + lastError);
}

async function main(): Promise<void> {
  if (!UPSTREAM_RPC) throw new Error("Missing ETHEREUM_FORK_UPSTREAM_RPC_URL");
  const response = await fetch(OPPORTUNITIES_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Morpho opportunities endpoint returned HTTP " + response.status);
  const payload = await response.json() as { validationBlock?: number; validationBlockHash?: string; data?: Candidate[] };
  const candidates = (payload.data ?? []).filter((candidate) =>
    candidate.status === "partially-validated" &&
    typeof candidate.collateralExitQuote?.swapPath === "string" &&
    typeof candidate.collateralExitQuote?.amountOut === "string" &&
    candidate.marketParams &&
    candidate.validationBlock > 0
  );
  if (candidates.length === 0) {
    out({
      status: "NO_EXECUTABLE_ROUTE_CANDIDATE",
      candidatesReturned: payload.data?.length ?? 0,
      reason: "No fresh Morpho candidate currently has both verified Aave reserve funding and a pinned-block Uniswap V3 swap path. No executor transaction was attempted."
    });
    return;
  }

  const forkBlock = candidates[0]!.validationBlock;
  const forkHash = candidates[0]!.validationBlockHash;
  const upstream = new JsonRpcProvider(UPSTREAM_RPC, 1, { staticNetwork: true });
  const upstreamFeeData = await upstream.getFeeData();
  const gasPrice = upstreamFeeData.gasPrice ?? upstreamFeeData.maxFeePerGas;
  if (!gasPrice || gasPrice <= 0n) throw new Error("Could not obtain a positive upstream gas-price estimate");

  let anvil: ChildProcessWithoutNullStreams | undefined;
  let provider: JsonRpcProvider | undefined;
  const rejected: Array<Record<string, unknown>> = [];
  try {
    anvil = spawn("anvil", [
      "--fork-url", UPSTREAM_RPC,
      "--fork-block-number", String(forkBlock),
      "--chain-id", "31337",
      "--port", "8545",
      "--gas-price", gasPrice.toString(),
      "--silent"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let anvilOutput = "";
    anvil.stdout.on("data", (chunk) => { anvilOutput = (anvilOutput + chunk.toString()).slice(-4000); });
    anvil.stderr.on("data", (chunk) => { anvilOutput = (anvilOutput + chunk.toString()).slice(-4000); });

    provider = new JsonRpcProvider(LOCAL_RPC, 31337, { staticNetwork: true });
    await waitForFork(provider, anvil);
    const forkBlockData = await provider.getBlock(forkBlock);
    if (!forkBlockData?.hash || forkBlockData.hash.toLowerCase() !== forkHash.toLowerCase()) {
      throw new Error("Anvil fork block hash does not match the opportunity scanner's pinned block");
    }

    const artifact = JSON.parse(await readFile(
      "out/MorphoAaveFlashloanForkExecutor.sol/MorphoAaveFlashloanForkExecutor.json", "utf8"
    )) as { abi: unknown[]; bytecode: { object: string } };
    const wallet = new Wallet(ANVIL_TEST_KEY, provider);
    const factory = new ContractFactory(artifact.abi, "0x" + artifact.bytecode.object.replace(/^0x/, ""), wallet);
    const executor = await factory.deploy(AAVE_POOL, MORPHO_BLUE, UNISWAP_V3_ROUTER);
    await executor.waitForDeployment();

    const executorAddress = await executor.getAddress();
    const detailedSimulation = executor.getFunction("simulateDetailed");
    const gasResults: Array<Record<string, unknown>> = [];

    for (const candidate of candidates) {
      try {
        const loanToken = getAddress(candidate.marketParams.loanToken);
        const collateralToken = getAddress(candidate.marketParams.collateralToken);
        const estimatedRepaidAssets = BigInt(candidate.estimatedRepaidAssets);
        if (estimatedRepaidAssets <= 0n) throw new Error("Estimated Morpho repayment is zero");
        const buffer = estimatedRepaidAssets / 10000n > 0n ? estimatedRepaidAssets / 10000n : 1n;
        const flashAmount = estimatedRepaidAssets + buffer;
        const seizedAssets = candidate.liquidationMath.mode === "seized-collateral"
          ? BigInt(candidate.estimatedSeizedCollateral) : 0n;
        const repaidShares = candidate.liquidationMath.mode === "seized-collateral"
          ? 0n : BigInt(candidate.estimatedRepaidShares);
        if ((seizedAssets === 0n) === (repaidShares === 0n)) {
          throw new Error("Candidate liquidation sizing did not select exactly one Morpho amount mode");
        }

        const plan = [
          [
            loanToken,
            collateralToken,
            getAddress(candidate.marketParams.oracle),
            getAddress(candidate.marketParams.irm),
            BigInt(candidate.marketParams.lltv)
          ],
          getAddress(candidate.borrower),
          seizedAssets,
          repaidShares,
          candidate.collateralExitQuote.swapPath!,
          1n,
          BigInt(forkBlockData.timestamp + 1200)
        ];

        // eth_call executes the complete Aave -> Morpho -> Uniswap -> Aave
        // callback path on the disposable fork and rolls all state changes back.
        const report = await detailedSimulation.staticCall(plan, flashAmount) as readonly bigint[];
        const gasEstimate = await detailedSimulation.estimateGas(plan, flashAmount);
        const feeData = await provider.getFeeData();
        const effectiveGasPrice = feeData.gasPrice ?? gasPrice;
        const gasCostWei = gasEstimate * effectiveGasPrice;
        let gasCostLoanToken: bigint;
        let gasConversion: Record<string, unknown> | null = null;

        if (loanToken.toLowerCase() === WETH.toLowerCase()) {
          gasCostLoanToken = gasCostWei;
        } else {
          const quote = await quoteUniswapV3BestRoute(
            LOCAL_RPC,
            { tokenIn: WETH, tokenOut: loanToken, amountIn: gasCostWei.toString() },
            forkBlock,
            31337
          );
          gasConversion = quote;
          if (quote.blockNumber !== forkBlock ||
              quote.blockHash.toLowerCase() !== forkHash.toLowerCase() ||
              typeof quote.amountOut !== "string" ||
              BigInt(quote.amountOut) <= 0n) {
            throw new Error("Could not price fork gas in the loan-token denomination at the same block");
          }
          gasCostLoanToken = BigInt(quote.amountOut);
        }

        const repaidAssets = BigInt(report[0] ?? 0n);
        const seizedOut = BigInt(report[1] ?? 0n);
        const swapOutput = BigInt(report[2] ?? 0n);
        const flashPremium = BigInt(report[3] ?? 0n);
        const grossProfit = BigInt(report[4] ?? 0n);
        const netProfit = grossProfit - gasCostLoanToken;
        const record = {
          borrower: candidate.borrower,
          marketId: candidate.marketId,
          validationBlock: forkBlock,
          validationBlockHash: forkHash,
          executor: executorAddress,
          loanToken,
          collateralToken,
          oracle: candidate.marketParams.oracle,
          oraclePrice: candidate.oraclePrice,
          debtAssetsSnapshot: candidate.debtAssets,
          collateralAssetsSnapshot: candidate.collateralAssets,
          liquidationMode: candidate.liquidationMath.mode,
          flashAmount: flashAmount.toString(),
          actualMorphoRepaidAssets: repaidAssets.toString(),
          actualMorphoSeizedCollateral: seizedOut.toString(),
          actualUniswapOutput: swapOutput.toString(),
          actualAaveFlashPremium: flashPremium.toString(),
          grossProfitLoanToken: grossProfit.toString(),
          gas: {
            estimatedGas: gasEstimate.toString(),
            gasPriceWei: effectiveGasPrice.toString(),
            estimatedGasCostWei: gasCostWei.toString(),
            estimatedGasCostLoanToken: gasCostLoanToken.toString(),
            conversion: gasConversion
          },
          netProfitAfterGasLoanToken: netProfit.toString(),
          settlementVerified: true,
          transactionSubmitted: false
        };

        if (netProfit > 0n) {
          out({
            status: "POSITIVE_FORK_ESTIMATE_AFTER_GAS",
            report: record,
            warning: "This is a successful eth_call and gas estimate on an isolated historical fork. It is not a signed or submitted transaction and excludes builder/MEV costs, inclusion uncertainty and future state changes."
          });
          return;
        }

        rejected.push({ ...record, rejection: "Net profit after gas is zero or negative" });
      } catch (error) {
        rejected.push({
          borrower: candidate.borrower,
          marketId: candidate.marketId,
          validationBlock: forkBlock,
          rejection: error instanceof Error ? error.message : String(error)
        });
      }
    }

    out({
      status: "ALL_CANDIDATES_REJECTED",
      validationBlock: forkBlock,
      validationBlockHash: forkHash,
      candidatesTested: candidates.length,
      rejected,
      transactionSubmitted: false
    });
    process.exitCode = 1;
  } finally {
    await provider?.destroy();
    await upstream.destroy();
    if (anvil && anvil.exitCode === null) {
      anvil.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        anvil!.once("close", () => resolve());
        setTimeout(resolve, 2000);
      });
    }
  }
}

main().catch((error) => {
  out({
    status: "FORK_EXECUTION_HARNESS_ERROR",
    message: error instanceof Error ? error.message : String(error),
    transactionSubmitted: false
  });
  process.exitCode = 1;
});
