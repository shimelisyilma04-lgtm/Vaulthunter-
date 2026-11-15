import { JsonRpcProvider } from "ethers";
import { config } from "./config.js";

async function main(): Promise<void> {
  if (!config.ETHEREUM_RPC_URL) {
    console.info("ETHEREUM_RPC_URL is not configured; skipping live RPC check.");
    return;
  }

  const provider = new JsonRpcProvider(config.ETHEREUM_RPC_URL, 1, {
    staticNetwork: true
  });

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) {
      throw new Error(`Expected Ethereum mainnet chain ID 1; received ${network.chainId}`);
    }

    const blockNumber = await provider.getBlockNumber();
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      throw new Error(`RPC returned an invalid latest block number: ${blockNumber}`);
    }

    console.info(JSON.stringify({
      ok: true,
      chainId: Number(network.chainId),
      latestBlock: blockNumber
    }));
  } finally {
    await provider.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Ethereum RPC check failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
