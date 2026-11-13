export interface EthereumRpcSnapshot {
  chainId: number;
  blockNumber: bigint;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: string;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

let nextRequestId = 1;

/**
 * Performs a read-only JSON-RPC request. This module deliberately exposes no
 * transaction-signing or transaction-submission methods.
 */
async function rpcRequest<T extends string>(
  rpcUrl: string,
  method: string
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method,
      params: []
    })
  });

  if (!response.ok) {
    throw new Error(`Ethereum RPC HTTP error: ${response.status}`);
  }

  const payload = (await response.json()) as JsonRpcResponse;

  if ("error" in payload) {
    throw new Error(
      `Ethereum RPC error ${payload.error.code}: ${payload.error.message}`
    );
  }

  if (typeof payload.result !== "string") {
    throw new Error("Ethereum RPC returned a non-string result");
  }

  return payload.result as T;
}

function parseHexNumber(value: string, label: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`Ethereum RPC returned an invalid ${label}`);
  }
  return BigInt(value);
}

/** Reads chain ID and latest block number without sending any transaction. */
export async function getEthereumRpcSnapshot(
  rpcUrl: string
): Promise<EthereumRpcSnapshot> {
  const [chainIdHex, blockNumberHex] = await Promise.all([
    rpcRequest<string>(rpcUrl, "eth_chainId"),
    rpcRequest<string>(rpcUrl, "eth_blockNumber")
  ]);

  const chainId = parseHexNumber(chainIdHex, "chain ID");
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Ethereum RPC returned a chain ID outside the safe range");
  }

  return {
    chainId: Number(chainId),
    blockNumber: parseHexNumber(blockNumberHex, "block number")
  };
}
