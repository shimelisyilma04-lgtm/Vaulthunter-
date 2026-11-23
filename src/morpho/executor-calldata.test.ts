import { describe, expect, it } from "vitest";
import { encodeMorphoExecutorSimulationCall } from "./executor-calldata.js";

const loan = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const collateral = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const address = "0x1111111111111111111111111111111111111111";
const path = "0x" + collateral.slice(2).toLowerCase() + "000bb8" + loan.slice(2).toLowerCase();

const plan = {
  marketParams: {
    loanToken: loan, collateralToken: collateral, oracle: address, irm: address, lltv: "860000000000000000"
  },
  borrower: address,
  seizedAssets: "0",
  repaidShares: "1000",
  swapPath: path,
  minProfit: "100",
  deadline: "2000000000"
};

describe("encodeMorphoExecutorSimulationCall", () => {
  it("encodes a valid one-hop executor simulation call", () => {
    const result = encodeMorphoExecutorSimulationCall(plan, "2000");
    expect(result.loanToken).toBe(loan);
    expect(result.flashAmount).toBe("2000");
    expect(result.data.startsWith("0x")).toBe(true);
    expect(result.data.length).toBeGreaterThan(10);
  });

  it("rejects plans that set both liquidation amount modes", () => {
    expect(() => encodeMorphoExecutorSimulationCall({ ...plan, seizedAssets: "1" }, "2000"))
      .toThrow("Exactly one");
  });

  it("rejects a swap path with the wrong endpoints", () => {
    expect(() => encodeMorphoExecutorSimulationCall({ ...plan, swapPath: path.replace(collateral.slice(2).toLowerCase(), address.slice(2)) }, "2000"))
      .toThrow("swapPath endpoints");
  });

  it("rejects zero minimum profit", () => {
    expect(() => encodeMorphoExecutorSimulationCall({ ...plan, minProfit: "0" }, "2000"))
      .toThrow("minProfit must be greater than zero");
  });
});
