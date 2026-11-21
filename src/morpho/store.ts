import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MorphoStorePort } from "./store-port.js";

export interface MorphoMarket {
  chainId: number;
  marketId: string;
  loanToken: string;
  collateralToken: string;
  oracleAddress: string;
  irmAddress: string;
  lltvWad: string;
  creationBlock: number;
}
export interface MorphoCheckpoint { lastBlock: number; lastBlockHash: string; }
export interface MorphoBorrower { address: string; }
export interface MorphoCandidate {
  marketId: string;
  borrower: string;
  observedBlock: number;
  borrowShares: string;
  debtAssets: string;
  collateralAssets: string;
  oraclePrice: string;
  lltvWad: string;
  healthFactorWad: string;
  snapshotUpdatedAt: string;
}

export class MorphoStore implements MorphoStorePort {
  private readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS morpho_markets (
        chain_id INTEGER NOT NULL, market_id TEXT NOT NULL,
        loan_token TEXT NOT NULL, collateral_token TEXT NOT NULL,
        oracle_address TEXT NOT NULL, irm_address TEXT NOT NULL,
        lltv_wad TEXT NOT NULL, creation_block INTEGER NOT NULL,
        last_block INTEGER, last_block_hash TEXT,
        PRIMARY KEY(chain_id, market_id)
      );
      CREATE TABLE IF NOT EXISTS morpho_global_checkpoint (
        chain_id INTEGER PRIMARY KEY, last_block INTEGER NOT NULL, last_block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS morpho_scan_state (
        chain_id INTEGER PRIMARY KEY, snapshot_market_offset INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS morpho_borrowers (
        chain_id INTEGER NOT NULL, market_id TEXT NOT NULL, address TEXT NOT NULL,
        observed_block INTEGER, borrow_shares TEXT, debt_assets TEXT,
        collateral_assets TEXT, oracle_price TEXT, lltv_wad TEXT,
        health_factor_wad TEXT, snapshot_updated_at TEXT,
        PRIMARY KEY(chain_id, market_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_morpho_candidates
        ON morpho_borrowers(chain_id, market_id, health_factor_wad);
    `);
  }
  upsertMarket(m: MorphoMarket): void {
    this.db.prepare(`
      INSERT INTO morpho_markets
      (chain_id,market_id,loan_token,collateral_token,oracle_address,irm_address,lltv_wad,creation_block)
      VALUES (@chainId,@marketId,@loanToken,@collateralToken,@oracleAddress,@irmAddress,@lltvWad,@creationBlock)
      ON CONFLICT(chain_id,market_id) DO UPDATE SET
        loan_token=excluded.loan_token, collateral_token=excluded.collateral_token,
        oracle_address=excluded.oracle_address, irm_address=excluded.irm_address,
        lltv_wad=excluded.lltv_wad, creation_block=excluded.creation_block
    `).run(m);
  }
  getCheckpoint(chainId: number, marketId: string): MorphoCheckpoint | null {
    const row = this.db.prepare("SELECT last_block AS lastBlock,last_block_hash AS lastBlockHash FROM morpho_markets WHERE chain_id=? AND market_id=?")
      .get(chainId, marketId) as MorphoCheckpoint | undefined;
    return row?.lastBlock === null || row?.lastBlock === undefined ? null : row;
  }
  getGlobalCheckpoint(chainId: number): MorphoCheckpoint | null {
    const row = this.db.prepare("SELECT last_block AS lastBlock,last_block_hash AS lastBlockHash FROM morpho_global_checkpoint WHERE chain_id=?")
      .get(chainId) as MorphoCheckpoint | undefined;
    return row ?? null;
  }
  resetGlobalCheckpoint(chainId: number): void {
    // Keep the discovered address set: every snapshot is re-read from canonical
    // state, so stale addresses are harmless and can be filtered by zero debt.
    this.db.prepare("DELETE FROM morpho_global_checkpoint WHERE chain_id=?").run(chainId);
  }
  saveGlobalBatch(chainId: number, entries: Array<{marketId:string;address:string}>, block: number, hash: string): void {
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO morpho_borrowers(chain_id,market_id,address) VALUES(?,?,?)");
      for (const entry of entries) insert.run(chainId, entry.marketId.toLowerCase(), entry.address.toLowerCase());
      this.db.prepare(`INSERT INTO morpho_global_checkpoint(chain_id,last_block,last_block_hash) VALUES(?,?,?)
        ON CONFLICT(chain_id) DO UPDATE SET last_block=excluded.last_block,last_block_hash=excluded.last_block_hash`)
        .run(chainId, block, hash);
    });
    tx();
  }
  saveDiscoveredBorrowers(chainId: number, entries: Array<{marketId:string;address:string}>): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO morpho_borrowers(chain_id,market_id,address) VALUES(?,?,?)");
    const tx = this.db.transaction(() => {
      for (const entry of entries) insert.run(chainId, entry.marketId.toLowerCase(), entry.address.toLowerCase());
    });
    tx();
  }
  getSnapshotMarketOffset(chainId: number): number {
    const row=this.db.prepare("SELECT snapshot_market_offset AS cursorValue FROM morpho_scan_state WHERE chain_id=?").get(chainId) as {cursorValue:number}|undefined;
    return row?.cursorValue ?? 0;
  }
  saveSnapshotMarketOffset(chainId: number, offset: number): void {
    this.db.prepare(`INSERT INTO morpho_scan_state(chain_id,snapshot_market_offset) VALUES(?,?)
      ON CONFLICT(chain_id) DO UPDATE SET snapshot_market_offset=excluded.snapshot_market_offset`).run(chainId,offset);
  }
  resetMarketCheckpoint(chainId: number, marketId: string): void {
    this.db.prepare("UPDATE morpho_markets SET last_block=NULL,last_block_hash=NULL WHERE chain_id=? AND market_id=?")
      .run(chainId, marketId);
  }
  saveBatch(chainId: number, marketId: string, addresses: string[], block: number, hash: string): void {
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO morpho_borrowers(chain_id,market_id,address)
        VALUES(?,?,?)
      `);
      for (const address of addresses) insert.run(chainId, marketId, address.toLowerCase());
      this.db.prepare("UPDATE morpho_markets SET last_block=?,last_block_hash=? WHERE chain_id=? AND market_id=?")
        .run(block, hash, chainId, marketId);
    });
    tx();
  }
  listBorrowers(chainId: number, marketId: string, limit: number): MorphoBorrower[] {
    return this.db.prepare(`
      SELECT address FROM morpho_borrowers WHERE chain_id=? AND market_id=?
      ORDER BY CASE WHEN snapshot_updated_at IS NULL THEN 0 ELSE 1 END, snapshot_updated_at ASC
      LIMIT ?
    `).all(chainId, marketId, limit) as MorphoBorrower[];
  }
  listBorrowerMarketIds(chainId: number): string[] {
    const rows = this.db.prepare("SELECT DISTINCT market_id AS marketId FROM morpho_borrowers WHERE chain_id=? ORDER BY market_id")
      .all(chainId) as Array<{ marketId: string }>;
    return rows.map((row) => row.marketId);
  }
  saveSnapshot(input: {
    chainId: number; marketId: string; address: string; observedBlock: number;
    borrowShares: string; debtAssets: string; collateralAssets: string;
    oraclePrice: string; lltvWad: string; healthFactorWad: string;
  }): void {
    this.db.prepare(`
      UPDATE morpho_borrowers SET observed_block=?,borrow_shares=?,debt_assets=?,
        collateral_assets=?,oracle_price=?,lltv_wad=?,health_factor_wad=?,
        snapshot_updated_at=CURRENT_TIMESTAMP
      WHERE chain_id=? AND market_id=? AND address=?
    `).run(input.observedBlock,input.borrowShares,input.debtAssets,input.collateralAssets,
      input.oraclePrice,input.lltvWad,input.healthFactorWad,input.chainId,input.marketId,input.address.toLowerCase());
  }
  listCandidates(chainId: number, marketId: string, limit=100): MorphoCandidate[] {
    const rows=this.db.prepare(`
      SELECT market_id AS marketId,address AS borrower,observed_block AS observedBlock,
        borrow_shares AS borrowShares,debt_assets AS debtAssets,
        collateral_assets AS collateralAssets,oracle_price AS oraclePrice,
        lltv_wad AS lltvWad,health_factor_wad AS healthFactorWad,
        snapshot_updated_at AS snapshotUpdatedAt
      FROM morpho_borrowers
      WHERE chain_id=? AND market_id=? AND debt_assets IS NOT NULL AND health_factor_wad IS NOT NULL
      LIMIT ?
    `).all(chainId,marketId,limit) as MorphoCandidate[];
    return rows.filter((r)=>BigInt(r.debtAssets)>0n && BigInt(r.healthFactorWad)<10n**18n)
      .sort((a,b)=>BigInt(a.healthFactorWad)<BigInt(b.healthFactorWad)?-1:BigInt(a.healthFactorWad)>BigInt(b.healthFactorWad)?1:0);
  }
  stats(chainId: number, marketId: string): { borrowers: number; indexedTo: number | null; candidates: number } {
    const borrowers=this.db.prepare("SELECT COUNT(*) AS n FROM morpho_borrowers WHERE chain_id=? AND market_id=?").get(chainId,marketId) as {n:number};
    const market=this.db.prepare("SELECT last_block AS lastBlock FROM morpho_markets WHERE chain_id=? AND market_id=?").get(chainId,marketId) as {lastBlock:number|null};
    const candidates=this.db.prepare("SELECT COUNT(*) AS n FROM morpho_borrowers WHERE chain_id=? AND market_id=? AND CAST(debt_assets AS REAL)>0 AND CAST(health_factor_wad AS REAL)<1000000000000000000").get(chainId,marketId) as {n:number};
    return {borrowers:borrowers.n,indexedTo:market.lastBlock,candidates:candidates.n};
  }
  getMonitorStats(chainId: number): {
    marketCount: number; borrowerCount: number; candidateCount: number;
    latestSnapshotBlock: number | null; checkpoint: MorphoCheckpoint | null;
  } {
    const markets = this.db.prepare("SELECT COUNT(*) AS n FROM morpho_markets WHERE chain_id=?").get(chainId) as {n:number};
    const borrowers = this.db.prepare("SELECT COUNT(*) AS n FROM morpho_borrowers WHERE chain_id=?").get(chainId) as {n:number};
    const candidates = this.db.prepare(`
      SELECT COUNT(*) AS n FROM morpho_borrowers
      WHERE chain_id=? AND debt_assets IS NOT NULL AND debt_assets<>'0'
        AND health_factor_wad IS NOT NULL
        AND (length(health_factor_wad)<19 OR
          (length(health_factor_wad)=19 AND health_factor_wad<'1000000000000000000'))
    `).get(chainId) as {n:number};
    const latest = this.db.prepare("SELECT MAX(observed_block) AS block FROM morpho_borrowers WHERE chain_id=?")
      .get(chainId) as {block:number|null};
    return {
      marketCount: markets.n, borrowerCount: borrowers.n, candidateCount: candidates.n,
      latestSnapshotBlock: latest.block, checkpoint: this.getGlobalCheckpoint(chainId)
    };
  }
  listLiquidationCandidates(chainId: number, limit: number): MorphoCandidate[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.prepare(`
      SELECT market_id AS marketId,address AS borrower,observed_block AS observedBlock,
        borrow_shares AS borrowShares,debt_assets AS debtAssets,
        collateral_assets AS collateralAssets,oracle_price AS oraclePrice,
        lltv_wad AS lltvWad,health_factor_wad AS healthFactorWad,
        snapshot_updated_at AS snapshotUpdatedAt
      FROM morpho_borrowers
      WHERE chain_id=? AND debt_assets IS NOT NULL AND debt_assets<>'0'
        AND health_factor_wad IS NOT NULL
        AND (length(health_factor_wad)<19 OR
          (length(health_factor_wad)=19 AND health_factor_wad<'1000000000000000000'))
      ORDER BY length(health_factor_wad),health_factor_wad ASC
      LIMIT ?
    `).all(chainId,safeLimit) as MorphoCandidate[];
  }
  close(): void { this.db.close(); }
}
