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

  it("paginates discovered borrowers into non-overlapping snapshot batches", () => {
    const store = makeStore();
    const addresses = [
      "0x0000000000000000000000000000000000000005",
      "0x0000000000000000000000000000000000000004",
      "0x0000000000000000000000000000000000000006",
      "0x0000000000000000000000000000000000000007"
    ];
    store.upsertDiscoveredBorrowers(1, event.poolAddress, addresses);

    const first = store.listBorrowers(1, event.poolAddress, 2, 0).map((row) => row.address);
    const second = store.listBorrowers(1, event.poolAddress, 2, 2).map((row) => row.address);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second]).size).toBe(4);
    expect(first).not.toEqual(second);
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
