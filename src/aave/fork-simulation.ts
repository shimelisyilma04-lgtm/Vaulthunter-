import { JsonRpcProvider, getAddress, toQuantity } from "ethers";

export interface ForkSimulationInput {
  to: string;
  data: string;
  value?: string;
  from?: string;
}

export async function simulateForkCall(
  forkRpcUrl: string,
  input: ForkSimulationInput,
  confirmations = 1
): Promise<{
  chainId: 1;
  forkBlock: number;
  safeBlock: number;
  to: string;
  from: string | null;
  value: string;
  callSucceeded: true;
  returnData: string;
  estimatedGas: string;
  simulationOnly: true;
  transactionSubmitted: false;
  warning: string;
}> {
  const to = getAddress(input.to);
  const from = input.from ? getAddress(input.from) : undefined;
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.data) || input.data.length > 32_770) {
    throw new Error("data must be valid even-length hex calldata no larger than 16 KB");
  }
  const value = input.value ?? "0";
  if (!/^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) {
    throw new Error("value must be a non-negative decimal or hex integer");
  }
  const valueBigInt = BigInt(value);
  if (valueBigInt < 0n || valueBigInt >= 2n ** 256n) {
    throw new Error("value is outside the uint256 range");
  }

  const provider = new JsonRpcProvider(forkRpcUrl, 1, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) {
      throw new Error("Fork simulation endpoint must be an Ethereum mainnet fork (chain ID 1)");
    }
    let nodeInfo: unknown;
    try {
      nodeInfo = await provider.send("anvil_nodeInfo", []);
    } catch {
      throw new Error("Simulation RPC is not a verified Anvil node. Use a private Anvil fork endpoint; mainnet RPCs are refused.");
    }
    if (!nodeInfo || typeof nodeInfo !== "object" || !("forkConfig" in nodeInfo) ||
        !(nodeInfo as { forkConfig?: unknown }).forkConfig) {
      throw new Error("Anvil RPC does not report an active fork configuration; refusing to simulate against a non-fork node.");
    }
    const forkBlock = await provider.getBlockNumber();
    const safeBlock = Math.max(0, forkBlock - confirmations);
    const tx = {
      to,
      data: input.data,
      value: toQuantity(valueBigInt),
      ...(from ? { from } : {})
    };
    // eth_call executes the supplied calldata against fork state without broadcasting.
    const returnData = await provider.send("eth_call", [tx, toQuantity(safeBlock)]) as string;
    // Estimate gas on the same isolated fork. This does not sign or submit a transaction.
    const estimatedGas = await provider.send("eth_estimateGas", [tx, toQuantity(safeBlock)]) as string;
    return {
      chainId: 1,
      forkBlock,
      safeBlock,
      to,
      from: from ?? null,
      value: valueBigInt.toString(),
      callSucceeded: true,
      returnData,
      estimatedGas: BigInt(estimatedGas).toString(),
      simulationOnly: true,
      transactionSubmitted: false,
      warning: "This is an eth_call plus gas estimate against the configured fork, not a proof of profitability or guaranteed execution. The calldata must represent the complete liquidation and callback path. Re-run immediately before any external action; no transaction is signed or broadcast."
    };
  } finally {
    await provider.destroy();
  }
}
