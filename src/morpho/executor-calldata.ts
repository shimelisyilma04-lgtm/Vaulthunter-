import { Interface, getAddress } from "ethers";

const EXECUTOR_INTERFACE = new Interface([
  "function simulate(((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),address borrower,uint256 seizedAssets,uint256 repaidShares,bytes swapPath,uint256 minProfit,uint256 deadline),uint256 flashAmount) returns (uint256 profitLoanToken)"
]);

export interface MorphoExecutorPlanInput {
  marketParams: {
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: string;
  };
  borrower: string;
  seizedAssets: string;
  repaidShares: string;
  swapPath: string;
  minProfit: string;
  deadline: string;
}

function uintString(value: unknown, name: string, allowZero = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new Error(name + " must be an unsigned base-10 integer string");
  }
  if (!allowZero && BigInt(value) === 0n) throw new Error(name + " must be greater than zero");
  return value;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(name + " must be an address");
  return getAddress(value);
}

/**
 * Encodes the exact executor call used by the isolated-fork simulation API.
 * This only prepares calldata; it does not deploy, sign, or submit anything.
 */
export function encodeMorphoExecutorSimulationCall(
  plan: MorphoExecutorPlanInput,
  flashAmountInput: unknown
): { data: string; loanToken: string; flashAmount: string } {
  if (!plan || typeof plan !== "object" || !plan.marketParams) throw new Error("plan.marketParams is required");
  const loanToken = address(plan.marketParams.loanToken, "marketParams.loanToken");
  const collateralToken = address(plan.marketParams.collateralToken, "marketParams.collateralToken");
  const oracle = address(plan.marketParams.oracle, "marketParams.oracle");
  const irm = address(plan.marketParams.irm, "marketParams.irm");
  const borrower = address(plan.borrower, "borrower");
  if (loanToken === collateralToken) throw new Error("Loan and collateral tokens must differ");

  const lltv = uintString(plan.marketParams.lltv, "marketParams.lltv");
  const seizedAssets = uintString(plan.seizedAssets, "seizedAssets", true);
  const repaidShares = uintString(plan.repaidShares, "repaidShares", true);
  if ((seizedAssets === "0") === (repaidShares === "0")) {
    throw new Error("Exactly one of seizedAssets or repaidShares must be positive");
  }
  const minProfit = uintString(plan.minProfit, "minProfit");
  const deadline = uintString(plan.deadline, "deadline");
  const flashAmount = uintString(flashAmountInput, "flashAmount");
  if (typeof plan.swapPath !== "string" || !/^0x[0-9a-fA-F]+$/.test(plan.swapPath)) {
    throw new Error("swapPath must be non-empty hex bytes");
  }
  const swapPath = plan.swapPath;
  const path = swapPath.toLowerCase();
  if ((path.length - 2) < 86 || ((path.length - 2 - 40) % 46) !== 0) {
    throw new Error("swapPath is not a valid packed Uniswap V3 path");
  }
  const first = getAddress("0x" + path.slice(2, 42));
  const last = getAddress("0x" + path.slice(-40));
  if (first !== collateralToken || last !== loanToken) {
    throw new Error("swapPath endpoints must be collateralToken then loanToken");
  }

  const data = EXECUTOR_INTERFACE.encodeFunctionData("simulate", [{
    marketParams: [loanToken, collateralToken, oracle, irm, BigInt(lltv)],
    borrower,
    seizedAssets: BigInt(seizedAssets),
    repaidShares: BigInt(repaidShares),
    swapPath,
    minProfit: BigInt(minProfit),
    deadline: BigInt(deadline)
  }, BigInt(flashAmount)]);
  return { data, loanToken, flashAmount };
}
