import { describe, expect, it } from "vitest";
import { simulateMorphoBlueDirectLiquidation } from "../src/morpho/fork-simulation.js";

describe("Morpho Blue direct liquidation fork simulation validation", () => {
  const base = {
    network: "base" as const,
    marketId: "0x" + "11".repeat(32),
    borrower: "0x0000000000000000000000000000000000000003",
    from: "0x0000000000000000000000000000000000000004"
  };

  it("requires exactly one positive liquidation amount before RPC use", async () => {
    await expect(simulateMorphoBlueDirectLiquidation("http://127.0.0.1:8545", base)).rejects.toThrow("Set exactly one");
    await expect(simulateMorphoBlueDirectLiquidation("http://127.0.0.1:8545", {
      ...base, seizedAssets: "1", repaidShares: "1"
    })).rejects.toThrow("Set exactly one");
    await expect(simulateMorphoBlueDirectLiquidation("http://127.0.0.1:8545", {
      ...base, repaidShares: "-1"
    })).rejects.toThrow("unsigned integer");
  });

  it("rejects invalid market IDs before RPC use", async () => {
    await expect(simulateMorphoBlueDirectLiquidation("http://127.0.0.1:8545", {
      ...base, marketId: "bad", repaidShares: "1"
    })).rejects.toThrow("marketId must be bytes32");
  });
});
