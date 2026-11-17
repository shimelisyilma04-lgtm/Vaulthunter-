import { describe, expect, it } from "vitest";
import { AAVE_V3_MARKETS } from "../src/aave/l2-readonly.js";

describe("Aave V3 L2 deployment registry", () => {
  it("matches the official Aave Address Book Base and Arbitrum providers", () => {
    expect(AAVE_V3_MARKETS.base.addressesProvider.toLowerCase())
      .toBe("0xe20fcdbbffc4dd138ce8b2e6fbb6cb49777ad64d");
    expect(AAVE_V3_MARKETS.arbitrum.addressesProvider.toLowerCase())
      .toBe("0xa97684ead0e402dc232d5a977953df7ecbab3cdb");
  });
});
