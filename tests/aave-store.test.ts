import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AaveStore } from "../src/aave/store.js";

const tempDirs: string[] = [];
const makeStore = (): AaveStore => {
  const dir = mkdtempSync(join(tmpdir(), "vaulthunter-indexer-"));
  tempDirs.push(dir);
  return new AaveStore(join(dir, "test.sqlite"));
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  it("returns only refreshed liquidatable accounts ordered by lowest health factor", () => {
    const store = makeStore();
    const second = {
      ...event,
      txHash: "0xdef",
      borrower: "0x0000000000000000000000000000000000000004"
    };
    store.saveEventsAndCheckpoint("aave-v3", 1, event.poolAddress, [event, second], 100, "0xblock100");
    store.saveSnapshot({
      chainId: 1,
      poolAddress: event.poolAddress,
      address: event.borrower,
      observedBlock: 200,
      totalCollateralBase: "1000000",
      totalDebtBase: "900000",
      healthFactorWad: "950000000000000000",
      liquidationEligible: true
    });
    store.saveSnapshot({
      chainId: 1,
      poolAddress: event.poolAddress,
      address: second.borrower,
      observedBlock: 200,
      totalCollateralBase: "1000000",
      totalDebtBase: "800000",
      healthFactorWad: "990000000000000000",
      liquidationEligible: true
    });
    expect(store.listCandidates(1, event.poolAddress).map((candidate) => candidate.address)).toEqual([
      event.borrower,
      second.borrower
    ]);
    store.close();
  });

});

const event = {
  chainId: 1,
  poolAddress: "0x0000000000000000000000000000000000000001",
  txHash: "0xabc",
  logIndex: 0,
  blockNumber: 100,
  blockHash: "0xblock100",
  borrower: "0x0000000000000000000000000000000000000002",
  reserve: "0x0000000000000000000000000000000000000003",
  amount: "12345",
  blockTimestamp: 1700000000
};

describe("Aave persistent event store", () => {
  it("persists events, distinct borrowers, and checkpoints", () => {
    const store = makeStore();
    store.saveEventsAndCheckpoint("aave-v3", 1, event.poolAddress, [event], 100, "0xblock100");
    expect(store.getCheckpoint("aave-v3", 1, event.poolAddress)).toEqual({
      lastBlock: 100,
      lastBlockHash: "0xblock100"
    });
    expect(store.listBorrowers(1, event.poolAddress)).toHaveLength(1);
    expect(store.getStats(1, event.poolAddress).eventCount).toBe(1);
    store.close();
  });

  it("is idempotent when the same event range is replayed", () => {
    const store = makeStore();
    store.saveEventsAndCheckpoint("aave-v3", 1, event.poolAddress, [event], 100, "0xblock100");
    store.saveEventsAndCheckpoint("aave-v3", 1, event.poolAddress, [event], 100, "0xblock100");
    expect(store.getStats(1, event.poolAddress).eventCount).toBe(1);
    store.close();
  });

  it("removes orphaned events and rebuilds borrower aggregates on rollback", () => {
    const store = makeStore();
    const later = { ...event, txHash: "0xdef", blockNumber: 110, blockHash: "0xblock110" };
    store.saveEventsAndCheckpoint("aave-v3", 1, event.poolAddress, [event, later], 110, "0xblock110");
    store.rollbackTo("aave-v3", 1, event.poolAddress, 100, "0xblock100");
    expect(store.getStats(1, event.poolAddress).eventCount).toBe(1);
    expect(store.getCheckpoint("aave-v3", 1, event.poolAddress)?.lastBlock).toBe(100);
    expect(store.listBorrowers(1, event.poolAddress)[0]?.lastSeenBlock).toBe(100);
    store.close();
  });
});
