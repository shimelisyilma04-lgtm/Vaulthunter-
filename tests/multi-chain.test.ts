import { describe, expect, it } from "vitest";
import { configuredNetworks } from "../src/chain/networks.js";

describe("multi-chain read-only configuration", () => {
  it("maps Base, Arbitrum and Scroll to their canonical chain IDs", () => {
    const networks = configuredNetworks({
      BASE_RPC_URL: "https://base.example",
      ARBITRUM_RPC_URL: "https://arb.example",
      SCROLL_RPC_URL: "https://scroll.example"
    });
    expect(networks.map((item) => [item.name, item.chainId])).toEqual([
      ["base", 8453],
      ["arbitrum", 42161],
      ["scroll", 534352]
    ]);
  });

  it("ignores networks without configured RPC endpoints", () => {
    expect(configuredNetworks({})).toEqual([]);
  });

  it("rejects malformed and unsupported RPC URLs", () => {
    expect(() => configuredNetworks({ BASE_RPC_URL: "not-a-url" })).toThrow();
    expect(() => configuredNetworks({ BASE_RPC_URL: "file:///tmp/rpc" })).toThrow();
  });
});
