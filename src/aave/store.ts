import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredBorrowEvent {
  chainId: number;
  poolAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  borrower: string;
  reserve: string;
  amount: string;
  blockTimestamp: number;
}

export interface IndexerCheckpoint {
  lastBlock: number;
  lastBlockHash: string;
}

export interface BorrowerRecord {
  address: string;
  firstSeenBlock: number;
  lastSeenBlock: number;
}

export interface BorrowerSnapshot {
  chainId: number;
  poolAddress: string;
  address: string;
  observedBlock: number;
  totalCollateralBase: string;
  totalDebtBase: string;
  healthFactorWad: string;
  liquidationEligible: boolean;
}

export class AaveStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_checkpoints (
        protocol TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        last_block INTEGER NOT NULL,
        last_block_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (protocol, chain_id, pool_address)
      );

      CREATE TABLE IF NOT EXISTS aave_borrow_events (
        chain_id INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        borrower TEXT NOT NULL,
        reserve TEXT NOT NULL,
        amount TEXT NOT NULL,
        block_timestamp INTEGER NOT NULL,
        PRIMARY KEY (chain_id, pool_address, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_aave_borrower_events
        ON aave_borrow_events(chain_id, pool_address, borrower, block_number);

      CREATE TABLE IF NOT EXISTS aave_borrowers (
        chain_id INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        address TEXT NOT NULL,
        first_seen_block INTEGER NOT NULL,
        last_seen_block INTEGER NOT NULL,
        observed_block INTEGER,
        total_collateral_base TEXT,
        total_debt_base TEXT,
        health_factor_wad TEXT,
        liquidation_eligible INTEGER NOT NULL DEFAULT 0,
        snapshot_updated_at TEXT,
        PRIMARY KEY (chain_id, pool_address, address)
      );
      CREATE INDEX IF NOT EXISTS idx_aave_liquidation_candidates
        ON aave_borrowers(chain_id, pool_address, liquidation_eligible, health_factor_wad);
    `);
  }

  getCheckpoint(protocol: string, chainId: number, poolAddress: string): IndexerCheckpoint | null {
    const row = this.db.prepare(`
      SELECT last_block AS lastBlock, last_block_hash AS lastBlockHash
      FROM indexer_checkpoints
      WHERE protocol = ? AND chain_id = ? AND pool_address = ?
    `).get(protocol, chainId, poolAddress) as IndexerCheckpoint | undefined;
    return row ?? null;
  }

  saveEventsAndCheckpoint(
    protocol: string,
    chainId: number,
    poolAddress: string,
    events: StoredBorrowEvent[],
    lastBlock: number,
    lastBlockHash: string
  ): void {
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO aave_borrow_events
      (chain_id, pool_address, tx_hash, log_index, block_number, block_hash,
       borrower, reserve, amount, block_timestamp)
      VALUES (@chainId, @poolAddress, @txHash, @logIndex, @blockNumber, @blockHash,
       @borrower, @reserve, @amount, @blockTimestamp)
    `);
    const upsertCheckpoint = this.db.prepare(`
      INSERT INTO indexer_checkpoints
      (protocol, chain_id, pool_address, last_block, last_block_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(protocol, chain_id, pool_address) DO UPDATE SET
        last_block = excluded.last_block,
        last_block_hash = excluded.last_block_hash,
        updated_at = CURRENT_TIMESTAMP
    `);
    const transaction = this.db.transaction(() => {
      const upsertBorrower = this.db.prepare(`
        INSERT INTO aave_borrowers
          (chain_id, pool_address, address, first_seen_block, last_seen_block)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chain_id, pool_address, address) DO UPDATE SET
          first_seen_block = MIN(aave_borrowers.first_seen_block, excluded.first_seen_block),
          last_seen_block = MAX(aave_borrowers.last_seen_block, excluded.last_seen_block)
      `);
      for (const event of events) {
        insertEvent.run(event);
        upsertBorrower.run(
          event.chainId, event.poolAddress, event.borrower, event.blockNumber, event.blockNumber
        );
      }
      upsertCheckpoint.run(protocol, chainId, poolAddress, lastBlock, lastBlockHash);
    });
    transaction();
  }

  rollbackTo(protocol: string, chainId: number, poolAddress: string, blockNumber: number, blockHash: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM aave_borrow_events
        WHERE chain_id = ? AND pool_address = ? AND block_number > ?
      `).run(chainId, poolAddress, blockNumber);
      this.db.prepare(`
        UPDATE indexer_checkpoints
        SET last_block = ?, last_block_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE protocol = ? AND chain_id = ? AND pool_address = ?
      `).run(blockNumber, blockHash, protocol, chainId, poolAddress);
      this.rebuildBorrowers(chainId, poolAddress);
    });
    transaction();
  }

  private rebuildBorrowers(chainId: number, poolAddress: string): void {
    this.db.prepare(`
      DELETE FROM aave_borrowers WHERE chain_id = ? AND pool_address = ?
    `).run(chainId, poolAddress);
    this.db.prepare(`
      INSERT INTO aave_borrowers
        (chain_id, pool_address, address, first_seen_block, last_seen_block)
      SELECT chain_id, pool_address, borrower, MIN(block_number), MAX(block_number)
      FROM aave_borrow_events
      WHERE chain_id = ? AND pool_address = ?
      GROUP BY chain_id, pool_address, borrower
    `).run(chainId, poolAddress);
  }

  listBorrowers(chainId: number, poolAddress: string, limit = 100): BorrowerRecord[] {
    return this.db.prepare(`
      SELECT address, first_seen_block AS firstSeenBlock, last_seen_block AS lastSeenBlock
      FROM aave_borrowers WHERE chain_id = ? AND pool_address = ?
      ORDER BY
        CASE WHEN snapshot_updated_at IS NULL THEN 0 ELSE 1 END ASC,
        snapshot_updated_at ASC,
        last_seen_block DESC
      LIMIT ?
    `).all(chainId, poolAddress, limit) as BorrowerRecord[];
  }

  saveSnapshot(snapshot: BorrowerSnapshot): void {
    this.db.prepare(`
      UPDATE aave_borrowers SET
        observed_block = ?, total_collateral_base = ?, total_debt_base = ?,
        health_factor_wad = ?, liquidation_eligible = ?, snapshot_updated_at = CURRENT_TIMESTAMP
      WHERE chain_id = ? AND pool_address = ? AND address = ?
    `).run(
      snapshot.observedBlock, snapshot.totalCollateralBase, snapshot.totalDebtBase,
      snapshot.healthFactorWad, snapshot.liquidationEligible ? 1 : 0,
      snapshot.chainId, snapshot.poolAddress, snapshot.address
    );
  }

  getStats(chainId: number, poolAddress: string): {
    eventCount: number; borrowerCount: number; candidateCount: number; checkpoint: IndexerCheckpoint | null;
  } {
    const events = this.db.prepare(`
      SELECT COUNT(*) AS count FROM aave_borrow_events WHERE chain_id = ? AND pool_address = ?
    `).get(chainId, poolAddress) as { count: number };
    const borrowers = this.db.prepare(`
      SELECT COUNT(*) AS count FROM aave_borrowers WHERE chain_id = ? AND pool_address = ?
    `).get(chainId, poolAddress) as { count: number };
    const candidates = this.db.prepare(`
      SELECT COUNT(*) AS count FROM aave_borrowers
      WHERE chain_id = ? AND pool_address = ? AND liquidation_eligible = 1
    `).get(chainId, poolAddress) as { count: number };
    return {
      eventCount: events.count,
      borrowerCount: borrowers.count,
      candidateCount: candidates.count,
      checkpoint: this.getCheckpoint("aave-v3", chainId, poolAddress)
    };
  }


  listBorrowerSnapshots(chainId: number, poolAddress: string, limit = 100, eligibleOnly = false): Array<{
    address: string; firstSeenBlock: number; lastSeenBlock: number; observedBlock: number | null;
    totalCollateralBase: string | null; totalDebtBase: string | null; healthFactorWad: string | null;
    liquidationEligible: boolean; snapshotUpdatedAt: string | null;
  }> {
    const eligibleClause = eligibleOnly ? "AND liquidation_eligible = 1" : "";
    const rows = this.db.prepare(`
      SELECT address, first_seen_block AS firstSeenBlock, last_seen_block AS lastSeenBlock,
        observed_block AS observedBlock, total_collateral_base AS totalCollateralBase,
        total_debt_base AS totalDebtBase, health_factor_wad AS healthFactorWad,
        liquidation_eligible AS liquidationEligible, snapshot_updated_at AS snapshotUpdatedAt
      FROM aave_borrowers
      WHERE chain_id = ? AND pool_address = ? ${eligibleClause}
      ORDER BY
        CASE WHEN health_factor_wad IS NULL THEN 1 ELSE 0 END ASC,
        CAST(health_factor_wad AS REAL) ASC,
        last_seen_block DESC
      LIMIT ?
    `).all(chainId, poolAddress, limit) as Array<{
      address: string; firstSeenBlock: number; lastSeenBlock: number; observedBlock: number | null;
      totalCollateralBase: string | null; totalDebtBase: string | null; healthFactorWad: string | null;
      liquidationEligible: number; snapshotUpdatedAt: string | null;
    }>;
    return rows.map((row) => ({ ...row, liquidationEligible: row.liquidationEligible === 1 }));
  }

  listRecentBorrowEvents(chainId: number, poolAddress: string, limit = 50): Array<{
    txHash: string; blockNumber: number; borrower: string; reserve: string;
    amount: string; blockTimestamp: number;
  }> {
    return this.db.prepare(`
      SELECT tx_hash AS txHash, block_number AS blockNumber, borrower, reserve,
        amount, block_timestamp AS blockTimestamp
      FROM aave_borrow_events
      WHERE chain_id = ? AND pool_address = ?
      ORDER BY block_number DESC, log_index DESC
      LIMIT ?
    `).all(chainId, poolAddress, limit) as Array<{
      txHash: string; blockNumber: number; borrower: string; reserve: string;
      amount: string; blockTimestamp: number;
    }>;
  }

  close(): void {
    this.db.close();
  }
}
