import { describe, expect, it } from "vitest";
import { MORPHO_BLUE_ADDRESSES } from "../src/morpho/blue.js";

describe("Morpho Blue deployment registry", () => {
  it("uses the official Base and Arbitrum Blue deployments", () => {
    expect(MORPHO_BLUE_ADDRESSES.base.toLowerCase()).toBe("0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb");
    expect(MORPHO_BLUE_ADDRESSES.arbitrum.toLowerCase()).toBe("0x6c247b1f6182318877311737bac0844baa518f5e");
  });
});
