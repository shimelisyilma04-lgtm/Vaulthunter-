import type { MorphoBorrower, MorphoCheckpoint, MorphoMarket } from "./store.js";

type MaybePromise<T> = T | Promise<T>;

export interface MorphoStorePort {
  upsertMarket(market: MorphoMarket): MaybePromise<void>;
  getGlobalCheckpoint(chainId: number): MaybePromise<MorphoCheckpoint | null>;
  resetGlobalCheckpoint(chainId: number): MaybePromise<void>;
  saveGlobalBatch(chainId: number, entries: Array<{ marketId: string; address: string }>, block: number, hash: string): MaybePromise<void>;
  getSnapshotMarketOffset(chainId: number): MaybePromise<number>;
  saveSnapshotMarketOffset(chainId: number, offset: number): MaybePromise<void>;
  listBorrowers(chainId: number, marketId: string, limit: number): MaybePromise<MorphoBorrower[]>;
  saveSnapshot(input: {
    chainId: number; marketId: string; address: string; observedBlock: number;
    borrowShares: string; debtAssets: string; collateralAssets: string;
    oraclePrice: string; lltvWad: string; healthFactorWad: string;
  }): MaybePromise<void>;
  close(): MaybePromise<void>;
}
