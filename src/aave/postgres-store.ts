import { Pool } from "pg";
import type {
  AaveStorePort, BorrowerRecord, BorrowerSnapshot, IndexerCheckpoint, StoredBorrowEvent
} from "./store.js";

export class PostgresAaveStore implements AaveStorePort {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "vaulthunter-indexer"
    });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS indexer_checkpoints (
        protocol TEXT NOT NULL, chain_id INTEGER NOT NULL, pool_address TEXT NOT NULL,
        last_block BIGINT NOT NULL, last_block_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (protocol, chain_id, pool_address)
      );
      CREATE TABLE IF NOT EXISTS aave_borrow_events (
        chain_id INTEGER NOT NULL, pool_address TEXT NOT NULL, tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL, block_number BIGINT NOT NULL, block_hash TEXT NOT NULL,
        borrower TEXT NOT NULL, reserve TEXT NOT NULL, amount TEXT NOT NULL,
        block_timestamp BIGINT NOT NULL,
        PRIMARY KEY (chain_id, pool_address, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_aave_borrower_events
        ON aave_borrow_events(chain_id, pool_address, borrower, block_number);
      CREATE TABLE IF NOT EXISTS aave_borrowers (
        chain_id INTEGER NOT NULL, pool_address TEXT NOT NULL, address TEXT NOT NULL,
        first_seen_block BIGINT NOT NULL, last_seen_block BIGINT NOT NULL,
        observed_block BIGINT, total_collateral_base TEXT, total_debt_base TEXT,
        health_factor_wad TEXT, liquidation_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        snapshot_updated_at TIMESTAMPTZ,
        PRIMARY KEY (chain_id, pool_address, address)
      );
      CREATE INDEX IF NOT EXISTS idx_aave_liquidation_candidates
        ON aave_borrowers(chain_id, pool_address, liquidation_eligible, health_factor_wad);
    `);
  }

  async getCheckpoint(protocol: string, chainId: number, poolAddress: string): Promise<IndexerCheckpoint | null> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT last_block::text AS "lastBlock", last_block_hash AS "lastBlockHash"
       FROM indexer_checkpoints WHERE protocol=$1 AND chain_id=$2 AND pool_address=$3`,
      [protocol, chainId, poolAddress]
    );
    const row = result.rows[0];
    return row ? { lastBlock: Number(row.lastBlock), lastBlockHash: String(row.lastBlockHash) } : null;
  }

  async saveEventsAndCheckpoint(
    protocol: string, chainId: number, poolAddress: string, events: StoredBorrowEvent[],
    lastBlock: number, lastBlockHash: string
  ): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO aave_borrow_events
           (chain_id,pool_address,tx_hash,log_index,block_number,block_hash,borrower,reserve,amount,block_timestamp)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [event.chainId,event.poolAddress,event.txHash,event.logIndex,event.blockNumber,event.blockHash,event.borrower,event.reserve,event.amount,event.blockTimestamp]
        );
        await client.query(
          `INSERT INTO aave_borrowers(chain_id,pool_address,address,first_seen_block,last_seen_block)
           VALUES($1,$2,$3,$4,$4)
           ON CONFLICT(chain_id,pool_address,address) DO UPDATE SET
             first_seen_block=LEAST(aave_borrowers.first_seen_block,EXCLUDED.first_seen_block),
             last_seen_block=GREATEST(aave_borrowers.last_seen_block,EXCLUDED.last_seen_block)`,
          [event.chainId,event.poolAddress,event.borrower,event.blockNumber]
        );
      }
      await client.query(
        `INSERT INTO indexer_checkpoints(protocol,chain_id,pool_address,last_block,last_block_hash,updated_at)
         VALUES($1,$2,$3,$4,$5,NOW())
         ON CONFLICT(protocol,chain_id,pool_address) DO UPDATE SET
           last_block=EXCLUDED.last_block,last_block_hash=EXCLUDED.last_block_hash,updated_at=NOW()`,
        [protocol,chainId,poolAddress,lastBlock,lastBlockHash]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rollbackTo(protocol: string, chainId: number, poolAddress: string, blockNumber: number, blockHash: string): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM aave_borrow_events WHERE chain_id=$1 AND pool_address=$2 AND block_number>$3",[chainId,poolAddress,blockNumber]);
      await client.query("DELETE FROM aave_borrowers WHERE chain_id=$1 AND pool_address=$2",[chainId,poolAddress]);
      await client.query(
        `INSERT INTO aave_borrowers(chain_id,pool_address,address,first_seen_block,last_seen_block)
         SELECT chain_id,pool_address,borrower,MIN(block_number),MAX(block_number)
         FROM aave_borrow_events WHERE chain_id=$1 AND pool_address=$2
         GROUP BY chain_id,pool_address`,
        [chainId,poolAddress]
      );
      await client.query(
        `INSERT INTO indexer_checkpoints(protocol,chain_id,pool_address,last_block,last_block_hash,updated_at)
         VALUES($1,$2,$3,$4,$5,NOW())
         ON CONFLICT(protocol,chain_id,pool_address) DO UPDATE SET
           last_block=EXCLUDED.last_block,last_block_hash=EXCLUDED.last_block_hash,updated_at=NOW()`,
        [protocol,chainId,poolAddress,blockNumber,blockHash]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listBorrowers(chainId: number, poolAddress: string, limit = 100): Promise<BorrowerRecord[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT address,first_seen_block AS "firstSeenBlock",last_seen_block AS "lastSeenBlock"
       FROM aave_borrowers WHERE chain_id=$1 AND pool_address=$2
       ORDER BY CASE WHEN snapshot_updated_at IS NULL THEN 0 ELSE 1 END,
       snapshot_updated_at ASC,last_seen_block DESC LIMIT $3`,
      [chainId,poolAddress,limit]
    );
    return result.rows.map((row) => ({
      address: String(row.address), firstSeenBlock: Number(row.firstSeenBlock), lastSeenBlock: Number(row.lastSeenBlock)
    }));
  }

  async upsertDiscoveredBorrowers(chainId: number, poolAddress: string, addresses: string[]): Promise<void> {
    await this.ready;
    if (addresses.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const address of addresses) {
        await client.query(
          `INSERT INTO aave_borrowers
           (chain_id,pool_address,address,first_seen_block,last_seen_block)
           VALUES($1,$2,$3,0,0) ON CONFLICT(chain_id,pool_address,address) DO NOTHING`,
          [chainId,poolAddress,address]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSnapshot(snapshot: BorrowerSnapshot): Promise<void> {
    await this.ready;
    await this.pool.query(
      `UPDATE aave_borrowers SET observed_block=$1,total_collateral_base=$2,total_debt_base=$3,
       health_factor_wad=$4,liquidation_eligible=$5,snapshot_updated_at=NOW()
       WHERE chain_id=$6 AND pool_address=$7 AND address=$8`,
      [snapshot.observedBlock,snapshot.totalCollateralBase,snapshot.totalDebtBase,snapshot.healthFactorWad,
       snapshot.liquidationEligible,snapshot.chainId,snapshot.poolAddress,snapshot.address]
    );
  }

  async getStats(chainId: number, poolAddress: string): Promise<{
    eventCount:number;borrowerCount:number;candidateCount:number;checkpoint:IndexerCheckpoint|null;
  }> {
    await this.ready;
    const [events,borrowers,candidates,checkpoint] = await Promise.all([
      this.pool.query("SELECT COUNT(*)::text AS count FROM aave_borrow_events WHERE chain_id=$1 AND pool_address=$2",[chainId,poolAddress]),
      this.pool.query("SELECT COUNT(*)::text AS count FROM aave_borrowers WHERE chain_id=$1 AND pool_address=$2",[chainId,poolAddress]),
      this.pool.query("SELECT COUNT(*)::text AS count FROM aave_borrowers WHERE chain_id=$1 AND pool_address=$2 AND liquidation_eligible=TRUE",[chainId,poolAddress]),
      this.getCheckpoint("aave-v3",chainId,poolAddress)
    ]);
    return {
      eventCount:Number(events.rows[0]?.count??0),
      borrowerCount:Number(borrowers.rows[0]?.count??0),
      candidateCount:Number(candidates.rows[0]?.count??0),
      checkpoint
    };
  }

  async listBorrowerSnapshots(chainId: number, poolAddress: string, limit = 100, eligibleOnly = false): Promise<Array<{
    address:string;firstSeenBlock:number;lastSeenBlock:number;observedBlock:number|null;
    totalCollateralBase:string|null;totalDebtBase:string|null;healthFactorWad:string|null;
    liquidationEligible:boolean;snapshotUpdatedAt:string|null;
  }>> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT address,first_seen_block::text AS "firstSeenBlock",last_seen_block::text AS "lastSeenBlock",
       observed_block::text AS "observedBlock",total_collateral_base AS "totalCollateralBase",
       total_debt_base AS "totalDebtBase",health_factor_wad AS "healthFactorWad",
       liquidation_eligible AS "liquidationEligible",snapshot_updated_at::text AS "snapshotUpdatedAt"
       FROM aave_borrowers WHERE chain_id=$1 AND pool_address=$2
       ${eligibleOnly ? "AND liquidation_eligible=TRUE" : ""}
       ORDER BY CASE WHEN health_factor_wad IS NULL THEN 1 ELSE 0 END,
       length(health_factor_wad),health_factor_wad,last_seen_block DESC LIMIT $3`,
      [chainId,poolAddress,limit]
    );
    return result.rows.map((row) => ({
      address:String(row.address),firstSeenBlock:Number(row.firstSeenBlock),lastSeenBlock:Number(row.lastSeenBlock),
      observedBlock:row.observedBlock===null?null:Number(row.observedBlock),
      totalCollateralBase:row.totalCollateralBase===null?null:String(row.totalCollateralBase),
      totalDebtBase:row.totalDebtBase===null?null:String(row.totalDebtBase),
      healthFactorWad:row.healthFactorWad===null?null:String(row.healthFactorWad),
      liquidationEligible:Boolean(row.liquidationEligible),
      snapshotUpdatedAt:row.snapshotUpdatedAt===null?null:String(row.snapshotUpdatedAt)
    }));
  }

  async listRecentBorrowEvents(chainId: number, poolAddress: string, limit = 50): Promise<Array<{
    txHash:string;blockNumber:number;borrower:string;reserve:string;amount:string;blockTimestamp:number;
  }>> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT tx_hash AS "txHash",block_number::text AS "blockNumber",borrower,reserve,
       amount,block_timestamp::text AS "blockTimestamp"
       FROM aave_borrow_events WHERE chain_id=$1 AND pool_address=$2
       ORDER BY block_number DESC,log_index DESC LIMIT $3`,
      [chainId,poolAddress,limit]
    );
    return result.rows.map((row) => ({
      txHash:String(row.txHash),blockNumber:Number(row.blockNumber),borrower:String(row.borrower),
      reserve:String(row.reserve),amount:String(row.amount),blockTimestamp:Number(row.blockTimestamp)
    }));
  }

  async close(): Promise<void> {
    await this.ready;
    await this.pool.end();
  }
}
