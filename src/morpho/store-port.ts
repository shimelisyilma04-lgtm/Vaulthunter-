import type { MorphoBorrower, MorphoCandidate, MorphoCheckpoint, MorphoMarket } from "./store.js";

type MaybePromise<T> = T | Promise<T>;

export interface MorphoMonitorStats {
  marketCount: number;
  borrowerCount: number;
  candidateCount: number;
  refreshedLast2Minutes: number;
  latestSnapshotAt: string | null;
  latestSnapshotBlock: number | null;
  checkpoint: MorphoCheckpoint | null;
}

export interface MorphoSimulationJobInput {
  chainId: number; marketId: string; borrower: string; validationBlock: number;
  validationBlockHash: string; priorityScore: number; priorityBand: "high" | "medium" | "low";
  payload: Record<string, unknown>;
}
export interface MorphoSimulationJob {
  id: number; chainId: number; marketId: string; borrower: string; validationBlock: number;
  validationBlockHash: string; priorityScore: number; priorityBand: "high" | "medium" | "low";
  status: "queued" | "running" | "completed" | "rejected" | "failed"; attempts: number;
  payload: Record<string, unknown>; result: Record<string, unknown> | null;
  lastError: string | null; createdAt: string; updatedAt: string;
}
export interface MorphoStorePort {
  upsertMarket(market: MorphoMarket): MaybePromise<void>;
  getGlobalCheckpoint(chainId: number): MaybePromise<MorphoCheckpoint | null>;
  resetGlobalCheckpoint(chainId: number): MaybePromise<void>;
  saveGlobalBatch(chainId: number, entries: Array<{ marketId: string; address: string }>, block: number, hash: string): MaybePromise<void>;
  saveDiscoveredBorrowers(chainId: number, entries: Array<{ marketId: string; address: string }>): MaybePromise<void>;
  getSnapshotMarketOffset(chainId: number): MaybePromise<number>;
  saveSnapshotMarketOffset(chainId: number, offset: number): MaybePromise<void>;
  listBorrowers(chainId: number, marketId: string, limit: number): MaybePromise<MorphoBorrower[]>;
  listBorrowerMarketIds(chainId: number): MaybePromise<string[]>;
  getMonitorStats(chainId: number): MaybePromise<MorphoMonitorStats>;
  enqueueSimulationJobs(jobs: MorphoSimulationJobInput[]): MaybePromise<number>;
  claimSimulationJob(chainId: number): MaybePromise<MorphoSimulationJob | null>;
  completeSimulationJob(id: number, status: "completed" | "rejected" | "failed", result: Record<string, unknown>, lastError?: string | null): MaybePromise<boolean>;
  listSimulationJobs(chainId: number, statuses: Array<"queued" | "running" | "completed" | "rejected" | "failed">, limit: number): MaybePromise<MorphoSimulationJob[]>;
  listLiquidationCandidates(chainId: number, limit: number): MaybePromise<MorphoCandidate[]>;
  listRiskPositions(chainId: number, limit: number): MaybePromise<MorphoCandidate[]>;
  saveSnapshot(input: {
    chainId: number; marketId: string; address: string; observedBlock: number;
    borrowShares: string; debtAssets: string; collateralAssets: string;
    oraclePrice: string; lltvWad: string; healthFactorWad: string;
  }): MaybePromise<void>;
  close(): MaybePromise<void>;
}
