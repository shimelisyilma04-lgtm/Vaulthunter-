import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MorphoStore, type MorphoMarket } from "../src/morpho/store.js";

const dirs: string[] = [];
function makeStore(): MorphoStore {
  const dir = mkdtempSync(join(tmpdir(), "vaulthunter-morpho-"));
  dirs.push(dir);
  return new MorphoStore(join(dir, "morpho.sqlite"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const market: MorphoMarket = {
  chainId: 1,
  marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  loanToken: "0x0000000000000000000000000000000000000001",
  collateralToken: "0x0000000000000000000000000000000000000002",
  oracleAddress: "0x0000000000000000000000000000000000000003",
  irmAddress: "0x0000000000000000000000000000000000000004",
  lltvWad: "860000000000000000",
  creationBlock: 100
};

describe("Morpho persistent market index", () => {
  it("persists market checkpoints and deduplicates borrower addresses", () => {
    const store = makeStore();
    store.upsertMarket(market);
    store.saveBatch(1, market.marketId, [
      "0x0000000000000000000000000000000000000005",
      "0x0000000000000000000000000000000000000005"
    ], 110, "0xblock");
    expect(store.getCheckpoint(1, market.marketId)).toEqual({ lastBlock: 110, lastBlockHash: "0xblock" });
    expect(store.listBorrowers(1, market.marketId, 20)).toHaveLength(1);
    store.close();
  });

  it("persists the global event checkpoint and deduplicates borrowers across event batches", () => {
    const store = makeStore();
    store.upsertMarket(market);
    const entries = [{ marketId: market.marketId, address: "0x0000000000000000000000000000000000000005" }];
    store.saveGlobalBatch(1, entries, 110, "0xglobalblock");
    store.saveGlobalBatch(1, entries, 120, "0xglobalblock2");
    expect(store.getGlobalCheckpoint(1)).toEqual({ lastBlock: 120, lastBlockHash: "0xglobalblock2" });
    expect(store.listBorrowers(1, market.marketId, 20)).toHaveLength(1);
    expect(store.listBorrowerMarketIds(1)).toEqual([market.marketId]);
    store.saveSnapshotMarketOffset(1, 12);
    expect(store.getSnapshotMarketOffset(1)).toBe(12);
    store.resetGlobalCheckpoint(1);
    expect(store.getGlobalCheckpoint(1)).toBeNull();
    store.close();
  });

  it("returns only debt positions below the exact WAD health threshold", () => {
    const store = makeStore();
    const borrower = "0x0000000000000000000000000000000000000005";
    store.upsertMarket(market);
    store.saveBatch(1, market.marketId, [borrower], 110, "0xblock");
    store.saveSnapshot({
      chainId: 1, marketId: market.marketId, address: borrower, observedBlock: 120,
      borrowShares: "100", debtAssets: "1000", collateralAssets: "1000",
      oraclePrice: "1000000000000000000000000000000000000",
      lltvWad: market.lltvWad, healthFactorWad: "990000000000000000"
    });
    expect(store.listCandidates(1, market.marketId)).toHaveLength(1);
    store.close();
  });

  it("clears a reorged checkpoint without deleting discovered borrowers", () => {
    const store = makeStore();
    store.upsertMarket(market);
    store.saveBatch(1, market.marketId, ["0x0000000000000000000000000000000000000005"], 110, "0xblock");
    store.resetMarketCheckpoint(1, market.marketId);
    expect(store.getCheckpoint(1, market.marketId)).toBeNull();
    expect(store.listBorrowers(1, market.marketId, 10)).toHaveLength(1);
    store.close();
  });
});
