import { describe, expect, it } from "vitest";
import { mapOnchainMorphoMarket } from "../src/morpho/scanner.js";

describe("Morpho historical market metadata fallback", () => {
  it("maps immutable market parameters read from the Morpho contract", () => {
    const marketId = `0x${"ab".repeat(32)}`;
    const market = mapOnchainMorphoMarket(
      marketId,
      [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        "0x0000000000000000000000000000000000000004",
        860000000000000000n
      ],
      18_919_858
    );

    expect(market).toEqual({
      chainId: 1,
      marketId,
      loanToken: "0x0000000000000000000000000000000000000001",
      collateralToken: "0x0000000000000000000000000000000000000002",
      oracleAddress: "0x0000000000000000000000000000000000000003",
      irmAddress: "0x0000000000000000000000000000000000000004",
      lltvWad: "860000000000000000",
      creationBlock: 18_919_858
    });
  });

  it("rejects malformed market IDs", () => {
    expect(() => mapOnchainMorphoMarket(
      "0x1234",
      [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        "0x0000000000000000000000000000000000000004",
        860000000000000000n
      ],
      18_919_858
    )).toThrow("Invalid Morpho market ID");
  });
});
