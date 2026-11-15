import { describe, expect, it } from "vitest";
import { simulateAaveLiquidationCall, simulateForkCall } from "./fork-simulation.js";

describe("simulateForkCall input validation", () => {
  it("rejects invalid contract addresses before opening an RPC connection", async () => {
    await expect(simulateForkCall("http://127.0.0.1:8545", {
      to: "not-an-address", data: "0x"
    })).rejects.toThrow();
  });

  it("rejects malformed or oversized calldata before RPC use", async () => {
    await expect(simulateForkCall("http://127.0.0.1:8545", {
      to: "0x0000000000000000000000000000000000000001", data: "0x123"
    })).rejects.toThrow();
    await expect(simulateForkCall("http://127.0.0.1:8545", {
      to: "0x0000000000000000000000000000000000000001", data: "0x" + "11".repeat(16_385)
    })).rejects.toThrow();
  });

  it("rejects malformed and out-of-range transaction values", async () => {
    await expect(simulateForkCall("http://127.0.0.1:8545", {
      to: "0x0000000000000000000000000000000000000001", data: "0x", value: "-1"
    })).rejects.toThrow();
    await expect(simulateForkCall("http://127.0.0.1:8545", {
      to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0x" + "f".repeat(65)
    })).rejects.toThrow();
  });
  it("rejects invalid direct Aave liquidation parameters before RPC use", async () => {
    await expect(simulateAaveLiquidationCall("http://127.0.0.1:8545", {
      collateralAsset: "bad",
      debtAsset: "0x0000000000000000000000000000000000000002",
      user: "0x0000000000000000000000000000000000000003",
      debtToCover: "1",
      receiveAToken: false,
      from: "0x0000000000000000000000000000000000000004"
    })).rejects.toThrow();
    await expect(simulateAaveLiquidationCall("http://127.0.0.1:8545", {
      collateralAsset: "0x0000000000000000000000000000000000000001",
      debtAsset: "0x0000000000000000000000000000000000000002",
      user: "0x0000000000000000000000000000000000000003",
      debtToCover: "0",
      receiveAToken: false,
      from: "0x0000000000000000000000000000000000000004"
    })).rejects.toThrow();
  });

});
