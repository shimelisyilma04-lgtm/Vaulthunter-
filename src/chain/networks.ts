/**
 * Verified EVM network identifiers used by VaultHunter's read-only discovery layer.
 * Protocol deployments are deliberately configured separately from chain identity:
 * a supported chain does not imply that every lending market is active there.
 */
export const SUPPORTED_NETWORKS = {
  ethereum: { chainId: 1, envKey: "ETHEREUM_RPC_URL" },
  base: { chainId: 8453, envKey: "BASE_RPC_URL" },
  arbitrum: { chainId: 42161, envKey: "ARBITRUM_RPC_URL" },
  scroll: { chainId: 534352, envKey: "SCROLL_RPC_URL" }
} as const;

export type NetworkName = keyof typeof SUPPORTED_NETWORKS;

export interface NetworkRpcConfig {
  name: NetworkName;
  chainId: number;
  rpcUrl: string;
}

export function configuredNetworks(env: Record<string, string | undefined>): NetworkRpcConfig[] {
  return (Object.entries(SUPPORTED_NETWORKS) as Array<[NetworkName, (typeof SUPPORTED_NETWORKS)[NetworkName]]>)
    .flatMap(([name, network]) => {
      const rpcUrl = env[network.envKey]?.trim();
      if (!rpcUrl) return [];
      let parsed: URL;
      try {
        parsed = new URL(rpcUrl);
      } catch {
        throw new Error(`Invalid ${network.envKey}: expected an HTTP(S) or WS(S) URL`);
      }
      if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
        throw new Error(`Invalid ${network.envKey}: unsupported URL protocol`);
      }
      return [{ name, chainId: network.chainId, rpcUrl }];
    });
}
