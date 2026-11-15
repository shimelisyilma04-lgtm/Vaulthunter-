import { describe, expect, it } from "vitest";
import { simulateForkCall } from "./fork-simulation.js";

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
});
