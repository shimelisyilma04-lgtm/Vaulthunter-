import { PostgresAaveStore } from "./postgres-store.js";
import {
  SqliteAaveStore,
  type AaveStorePort,
  type BorrowerRecord,
  type BorrowerSnapshot,
  type IndexerCheckpoint,
  type StoredBorrowEvent
} from "./store.js";

export class AaveStore implements AaveStorePort {
  private readonly sqlite?: SqliteAaveStore;
  private readonly postgres?: PostgresAaveStore;

  constructor(sqlitePath: string, databaseUrl?: string) {
    if (databaseUrl) {
      this.postgres = new PostgresAaveStore(databaseUrl);
      console.info("VaultHunter storage backend: PostgreSQL (durable external database)");
    } else {
      this.sqlite = new SqliteAaveStore(sqlitePath);
      console.warn("VaultHunter storage backend: local SQLite (ephemeral on Render Free)");
    }
  }

  async getCheckpoint(protocol:string,chainId:number,poolAddress:string):Promise<IndexerCheckpoint|null>{
    return this.postgres ? this.postgres.getCheckpoint(protocol,chainId,poolAddress) : this.sqlite!.getCheckpoint(protocol,chainId,poolAddress);
  }
  async saveEventsAndCheckpoint(protocol:string,chainId:number,poolAddress:string,events:StoredBorrowEvent[],lastBlock:number,lastBlockHash:string):Promise<void>{
    if(this.postgres)return this.postgres.saveEventsAndCheckpoint(protocol,chainId,poolAddress,events,lastBlock,lastBlockHash);
    this.sqlite!.saveEventsAndCheckpoint(protocol,chainId,poolAddress,events,lastBlock,lastBlockHash);
  }
  async rollbackTo(protocol:string,chainId:number,poolAddress:string,blockNumber:number,blockHash:string):Promise<void>{
    if(this.postgres)return this.postgres.rollbackTo(protocol,chainId,poolAddress,blockNumber,blockHash);
    this.sqlite!.rollbackTo(protocol,chainId,poolAddress,blockNumber,blockHash);
  }
  async listBorrowers(chainId:number,poolAddress:string,limit=100):Promise<BorrowerRecord[]>{
    return this.postgres ? this.postgres.listBorrowers(chainId,poolAddress,limit) : this.sqlite!.listBorrowers(chainId,poolAddress,limit);
  }
  async saveSnapshot(snapshot:BorrowerSnapshot):Promise<void>{
    if(this.postgres)return this.postgres.saveSnapshot(snapshot);
    this.sqlite!.saveSnapshot(snapshot);
  }
  async getStats(chainId:number,poolAddress:string):Promise<{eventCount:number;borrowerCount:number;candidateCount:number;checkpoint:IndexerCheckpoint|null}>{
    return this.postgres ? this.postgres.getStats(chainId,poolAddress) : this.sqlite!.getStats(chainId,poolAddress);
  }
  async listBorrowerSnapshots(chainId:number,poolAddress:string,limit=100,eligibleOnly=false):Promise<Array<{
    address:string;firstSeenBlock:number;lastSeenBlock:number;observedBlock:number|null;
    totalCollateralBase:string|null;totalDebtBase:string|null;healthFactorWad:string|null;
    liquidationEligible:boolean;snapshotUpdatedAt:string|null;
  }>>{
    return this.postgres ? this.postgres.listBorrowerSnapshots(chainId,poolAddress,limit,eligibleOnly) : this.sqlite!.listBorrowerSnapshots(chainId,poolAddress,limit,eligibleOnly);
  }
  async listRecentBorrowEvents(chainId:number,poolAddress:string,limit=50):Promise<Array<{
    txHash:string;blockNumber:number;borrower:string;reserve:string;amount:string;blockTimestamp:number;
  }>>{
    return this.postgres ? this.postgres.listRecentBorrowEvents(chainId,poolAddress,limit) : this.sqlite!.listRecentBorrowEvents(chainId,poolAddress,limit);
  }
  async close():Promise<void>{
    if(this.postgres)await this.postgres.close();
    else this.sqlite!.close();
  }
}
