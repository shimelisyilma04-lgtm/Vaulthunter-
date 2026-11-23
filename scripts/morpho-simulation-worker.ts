import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  ContractFactory, JsonRpcProvider, Wallet, getAddress, type InterfaceAbi
} from "ethers";
import { quoteUniswapV3BestRoute } from "../src/aave/uniswap-quote.js";

const API = process.env.VAULTHUNTER_API_URL ?? "https://vaulthunter-core.onrender.com";
const TOKEN = process.env.VAULTHUNTER_SIMULATION_API_TOKEN;
const UPSTREAM_RPC = process.env.ETHEREUM_FORK_UPSTREAM_RPC_URL;
const LOCAL_RPC = "http://127.0.0.1:8545";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ANVIL_TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

type Candidate = {
  borrower: string; marketId: string; validationBlock: number; validationBlockHash: string;
  marketParams: { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string };
  oraclePrice: string;
  marketState: Record<string, string>;
  positionState: { supplyShares: string; borrowShares: string; collateralAssets: string };
  debtAssets: string; collateralAssets: string;
  estimatedRepaidAssets: string; estimatedRepaidShares: string; estimatedSeizedCollateral: string;
  liquidationMath: { mode: string };
  collateralExitQuote: { amountOut: string | null; swapPath?: string | null; routeType?: string };
  status: string;
};
type Job = { id: number; validationBlock: number; validationBlockHash: string; payload: Candidate };

async function api(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
  const response = await fetch(API + path, {
    method, headers: { accept: "application/json", authorization: "Bearer " + TOKEN,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw new Error("API returned non-JSON HTTP " + response.status); }
  if (!response.ok) throw new Error("API HTTP " + response.status + ": " + JSON.stringify(parsed).slice(0, 800));
  return parsed;
}
async function record(jobId: number, status: "completed" | "rejected" | "failed", result: Record<string, unknown>, lastError: string | null = null): Promise<void> {
  await api("/api/v1/morpho/simulations/" + jobId + "/result", "POST", { status, result, lastError });
}
async function waitForFork(provider: JsonRpcProvider, child: ChildProcess): Promise<void> {
  let reason = "Anvil not ready";
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("Anvil exited before ready");
    try {
      if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Fork chain ID is not 31337");
      return;
    } catch (error) { reason = error instanceof Error ? error.message : String(error); await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error("Anvil readiness timeout: " + reason);
}

async function simulate(job: Job): Promise<{ status: "completed" | "rejected"; result: Record<string, unknown> }> {
  const c = job.payload;
  if (!UPSTREAM_RPC) throw new Error("Missing ETHEREUM_FORK_UPSTREAM_RPC_URL");
  if (c.validationBlock !== job.validationBlock || c.validationBlockHash.toLowerCase() !== job.validationBlockHash.toLowerCase()) {
    throw new Error("Queued candidate does not match the job's pinned block metadata");
  }
  if (c.status !== "partially-validated" || !c.marketParams || typeof c.collateralExitQuote?.swapPath !== "string") {
    throw new Error("Queued payload is missing a partially-validated candidate or V3 swap path");
  }
  const upstream = new JsonRpcProvider(UPSTREAM_RPC, 1, { staticNetwork: true });
  let anvil: ChildProcess | undefined;
  let local: JsonRpcProvider | undefined;
  try {
    const feeData = await upstream.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (!gasPrice || gasPrice <= 0n) throw new Error("No positive upstream gas price available");
    anvil = spawn("anvil", ["--fork-url", UPSTREAM_RPC, "--fork-block-number", String(job.validationBlock),
      "--chain-id", "31337", "--port", "8545", "--gas-price", gasPrice.toString(), "--silent"],
      { stdio: ["ignore", "ignore", "pipe"] });
    anvil.stderr?.on("data", () => undefined);
    local = new JsonRpcProvider(LOCAL_RPC, 31337, { staticNetwork: true });
    await waitForFork(local, anvil);
    const block = await local.getBlock(job.validationBlock);
    if (!block?.hash || block.hash.toLowerCase() !== job.validationBlockHash.toLowerCase()) {
      throw new Error("Pinned fork block hash mismatch; refusing to simulate stale or different state");
    }
    const artifact = JSON.parse(await readFile("out/MorphoAaveFlashloanForkExecutor.sol/MorphoAaveFlashloanForkExecutor.json", "utf8")) as {
      abi: InterfaceAbi; bytecode: { object: string };
    };
    const wallet = new Wallet(ANVIL_TEST_KEY, local);
    const factory = new ContractFactory(artifact.abi, "0x" + artifact.bytecode.object.replace(/^0x/, ""), wallet);
    const executor = await factory.deploy(AAVE_POOL, MORPHO_BLUE, UNISWAP_V3_ROUTER);
    await executor.waitForDeployment();
    const loanToken = getAddress(c.marketParams.loanToken);
    const collateralToken = getAddress(c.marketParams.collateralToken);
    const estimatedRepay = BigInt(c.estimatedRepaidAssets);
    if (estimatedRepay <= 0n) throw new Error("Candidate estimated repayment is zero");
    const flashAmount = estimatedRepay + (estimatedRepay / 10000n || 1n);
    const seizedAssets = c.liquidationMath.mode === "seized-collateral" ? BigInt(c.estimatedSeizedCollateral) : 0n;
    const repaidShares = c.liquidationMath.mode === "seized-collateral" ? 0n : BigInt(c.estimatedRepaidShares);
    if ((seizedAssets === 0n) === (repaidShares === 0n)) throw new Error("Invalid Morpho liquidation amount mode");
    const plan = [[loanToken, collateralToken, getAddress(c.marketParams.oracle), getAddress(c.marketParams.irm),
      BigInt(c.marketParams.lltv)], getAddress(c.borrower), seizedAssets, repaidShares, c.collateralExitQuote.swapPath, 1n,
      BigInt(block.timestamp + 1200)];
    const sim = executor.getFunction("simulateDetailed");
    const report = await sim.staticCall(plan, flashAmount) as readonly bigint[];
    const gasEstimate = await sim.estimateGas(plan, flashAmount);
    const localFees = await local.getFeeData();
    const effectiveGasPrice = localFees.gasPrice ?? gasPrice;
    const gasCostWei = gasEstimate * effectiveGasPrice;
    let gasCostLoanToken: bigint;
    let gasConversion: Record<string, unknown> | null = null;
    if (loanToken.toLowerCase() === WETH.toLowerCase()) gasCostLoanToken = gasCostWei;
    else {
      const quote = await quoteUniswapV3BestRoute(LOCAL_RPC,
        { tokenIn: WETH, tokenOut: loanToken, amountIn: gasCostWei.toString() }, job.validationBlock, 31337);
      if (quote.blockNumber !== job.validationBlock || quote.blockHash.toLowerCase() !== job.validationBlockHash.toLowerCase() ||
          typeof quote.amountOut !== "string" || BigInt(quote.amountOut) <= 0n) {
        throw new Error("Unable to price gas in loan-token units at the pinned fork block");
      }
      gasConversion = quote;
      gasCostLoanToken = BigInt(quote.amountOut);
    }
    const repaid = BigInt(report[0] ?? 0n), seized = BigInt(report[1] ?? 0n);
    const swapOutput = BigInt(report[2] ?? 0n), premium = BigInt(report[3] ?? 0n);
    const gross = BigInt(report[4] ?? 0n), net = gross - gasCostLoanToken;
    const result = {
      jobId: job.id, borrower: c.borrower, marketId: c.marketId, validationBlock: job.validationBlock,
      validationBlockHash: job.validationBlockHash, executor: await executor.getAddress(), loanToken, collateralToken,
      oracle: c.marketParams.oracle, oraclePrice: c.oraclePrice, marketState: c.marketState, positionState: c.positionState,
      debtAssetsSnapshot: c.debtAssets, collateralAssetsSnapshot: c.collateralAssets,
      liquidationMode: c.liquidationMath.mode, flashAmount: flashAmount.toString(),
      actualMorphoRepaidAssets: repaid.toString(), actualMorphoSeizedCollateral: seized.toString(),
      actualUniswapOutput: swapOutput.toString(), actualAaveFlashPremium: premium.toString(),
      grossProfitLoanToken: gross.toString(), gas: { estimatedGas: gasEstimate.toString(),
        gasPriceWei: effectiveGasPrice.toString(), estimatedGasCostWei: gasCostWei.toString(),
        estimatedGasCostLoanToken: gasCostLoanToken.toString(), conversion: gasConversion },
      netProfitAfterGasLoanToken: net.toString(), settlementVerified: true,
      transactionSubmitted: false, simulationOnly: true, eligibleForMainnetExecution: false,
      exclusions: ["builder/MEV costs", "inclusion uncertainty", "future state changes"]
    };
    return { status: net > 0n ? "completed" : "rejected",
      result: { ...result, decision: net > 0n ? "positive-fork-estimate-after-gas" : "reject-non-positive-after-gas" } };
  } finally {
    await local?.destroy();
    await upstream.destroy();
    if (anvil && anvil.exitCode === null) {
      anvil.kill("SIGTERM");
      await new Promise<void>(resolve => { anvil!.once("close", () => resolve()); setTimeout(resolve, 2000); });
    }
  }
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error("Missing VAULTHUNTER_SIMULATION_API_TOKEN");
  const claimed = await api("/api/v1/morpho/simulations/claim", "POST", {});
  const job = claimed.job as Job | null;
  if (!job) { process.stdout.write(JSON.stringify({ status: "QUEUE_EMPTY", transactionSubmitted: false }) + "\n"); return; }
  try {
    const outcome = await simulate(job);
    await record(job.id, outcome.status, outcome.result);
    process.stdout.write(JSON.stringify({ status: outcome.status, jobId: job.id, result: outcome.result, transactionSubmitted: false }, null, 2) + "\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = { jobId: job.id, stage: "fork-simulation", error: message, transactionSubmitted: false,
      simulationOnly: true, eligibleForMainnetExecution: false };
    try {
      await record(job.id, "failed", failed, message);
      process.stdout.write(JSON.stringify({ status: "failed-recorded", ...failed }, null, 2) + "\n");
    } catch (recordError) {
      process.stderr.write("CRITICAL: job " + job.id + " failed and result could not be persisted: " +
        (recordError instanceof Error ? recordError.message : String(recordError)) + "\n");
      process.exitCode = 1;
    }
  }
}
main().catch(error => { process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n"); process.exitCode = 1; });
