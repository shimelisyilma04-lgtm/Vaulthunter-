import { describe, expect, it } from "vitest";
import { simulateAaveL2DirectLiquidation } from "../src/aave/l2-fork-simulation.js";

describe("Aave L2 direct liquidation fork simulation validation", () => {
  it("rejects malformed addresses and zero debt before RPC use", async () => {
    await expect(simulateAaveL2DirectLiquidation("http://127.0.0.1:8545", {
      network: "base", collateralAsset: "bad",
      debtAsset: "0x0000000000000000000000000000000000000002",
      borrower: "0x0000000000000000000000000000000000000003",
      debtToCover: "1", receiveAToken: false,
      from: "0x0000000000000000000000000000000000000004"
    })).rejects.toThrow();
    await expect(simulateAaveL2DirectLiquidation("http://127.0.0.1:8545", {
      network: "arbitrum",
      collateralAsset: "0x0000000000000000000000000000000000000001",
      debtAsset: "0x0000000000000000000000000000000000000002",
      borrower: "0x0000000000000000000000000000000000000003",
      debtToCover: "0", receiveAToken: false,
      from: "0x0000000000000000000000000000000000000004"
    })).rejects.toThrow();
  });
});
