import { configuredNetworks, type NetworkName } from "./networks.js";

export interface NetworkHealth {
  network: NetworkName;
  expectedChainId: number;
  actualChainId: number | null;
  latestBlock: string | null;
  status: "connected" | "wrong-chain" | "unavailable";
  error?: string;
}

interface RpcResponse {
  result?: string;
  error?: { code: number; message: string };
}

async function rpc(rpcUrl: string, method: string): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json() as RpcResponse;
  if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  if (typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) {
    throw new Error("RPC returned an invalid hexadecimal result");
  }
  return body.result;
}

/** Read-only chain health probe. It never signs or broadcasts transactions. */
export async function inspectConfiguredNetworks(
  env: Record<string, string | undefined> = process.env
): Promise<NetworkHealth[]> {
  const networks = configuredNetworks(env);
  return Promise.all(networks.map(async (network): Promise<NetworkHealth> => {
    try {
      const [chainIdHex, blockHex] = await Promise.all([
        rpc(network.rpcUrl, "eth_chainId"),
        rpc(network.rpcUrl, "eth_blockNumber")
      ]);
      const actualChainId = Number(BigInt(chainIdHex));
      return {
        network: network.name,
        expectedChainId: network.chainId,
        actualChainId,
        latestBlock: BigInt(blockHex).toString(),
        status: actualChainId === network.chainId ? "connected" : "wrong-chain"
      };
    } catch (error) {
      return {
        network: network.name,
        expectedChainId: network.chainId,
        actualChainId: null,
        latestBlock: null,
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}
