import { Pool } from "pg";
import type { MorphoBorrower, MorphoCandidate, MorphoCheckpoint, MorphoMarket } from "./store.js";
import type { MorphoMonitorStats, MorphoStorePort } from "./store-port.js";

export class PostgresMorphoStore implements MorphoStorePort {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "vaulthunter-morpho-indexer"
    });
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS morpho_markets (
        chain_id INTEGER NOT NULL, market_id TEXT NOT NULL,
        loan_token TEXT NOT NULL, collateral_token TEXT NOT NULL,
        oracle_address TEXT NOT NULL, irm_address TEXT NOT NULL,
        lltv_wad TEXT NOT NULL, creation_block BIGINT NOT NULL,
        PRIMARY KEY (chain_id, market_id)
      );
      CREATE TABLE IF NOT EXISTS morpho_global_checkpoint (
        chain_id INTEGER PRIMARY KEY, last_block BIGINT NOT NULL, last_block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS morpho_scan_state (
        chain_id INTEGER PRIMARY KEY, snapshot_market_offset INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS morpho_borrowers (
        chain_id INTEGER NOT NULL, market_id TEXT NOT NULL, address TEXT NOT NULL,
        observed_block BIGINT, borrow_shares TEXT, debt_assets TEXT,
        collateral_assets TEXT, oracle_price TEXT, lltv_wad TEXT,
        health_factor_wad TEXT, snapshot_updated_at TIMESTAMPTZ,
        PRIMARY KEY (chain_id, market_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_morpho_candidates
        ON morpho_borrowers(chain_id, market_id, health_factor_wad);
    `);
  }

  async upsertMarket(m: MorphoMarket): Promise<void> {
    await this.ready;
    await this.pool.query(`
      INSERT INTO morpho_markets
      (chain_id,market_id,loan_token,collateral_token,oracle_address,irm_address,lltv_wad,creation_block)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(chain_id,market_id) DO UPDATE SET
        loan_token=EXCLUDED.loan_token,collateral_token=EXCLUDED.collateral_token,
        oracle_address=EXCLUDED.oracle_address,irm_address=EXCLUDED.irm_address,
        lltv_wad=EXCLUDED.lltv_wad,creation_block=EXCLUDED.creation_block
    `, [m.chainId,m.marketId.toLowerCase(),m.loanToken,m.collateralToken,m.oracleAddress,m.irmAddress,m.lltvWad,m.creationBlock]);
  }

  async getGlobalCheckpoint(chainId: number): Promise<MorphoCheckpoint | null> {
    await this.ready;
    const r = await this.pool.query(
      "SELECT last_block::text AS block,last_block_hash AS hash FROM morpho_global_checkpoint WHERE chain_id=$1",
      [chainId]
    );
    const row = r.rows[0];
    return row ? { lastBlock: Number(row.block), lastBlockHash: String(row.hash) } : null;
  }

  async resetGlobalCheckpoint(chainId: number): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Keep the discovered address set; canonical position refresh filters stale addresses.
      await client.query("DELETE FROM morpho_global_checkpoint WHERE chain_id=$1", [chainId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async saveGlobalBatch(
    chainId: number, entries: Array<{marketId:string;address:string}>, block: number, hash: string
  ): Promise<void> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        await client.query(
          "INSERT INTO morpho_borrowers(chain_id,market_id,address) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [chainId,entry.marketId.toLowerCase(),entry.address.toLowerCase()]
        );
      }
      await client.query(`
        INSERT INTO morpho_global_checkpoint(chain_id,last_block,last_block_hash) VALUES($1,$2,$3)
        ON CONFLICT(chain_id) DO UPDATE SET
          last_block=GREATEST(morpho_global_checkpoint.last_block,EXCLUDED.last_block),
          last_block_hash=CASE
            WHEN EXCLUDED.last_block >= morpho_global_checkpoint.last_block
            THEN EXCLUDED.last_block_hash
            ELSE morpho_global_checkpoint.last_block_hash
          END
      `, [chainId,block,hash]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async saveDiscoveredBorrowers(chainId: number, entries: Array<{marketId:string;address:string}>): Promise<void> {
    await this.ready;
    for (let offset = 0; offset < entries.length; offset += 500) {
      const batch = entries.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      const values = batch.map((_, index) => {
        const base = index * 3;
        return "(" + "$" + (base + 1) + ",$" + (base + 2) + ",$" + (base + 3) + ")";
      }).join(",");
      const params = batch.flatMap((entry) => [
        chainId, entry.marketId.toLowerCase(), entry.address.toLowerCase()
      ]);
      await this.pool.query(
        `INSERT INTO morpho_borrowers(chain_id,market_id,address) VALUES ${values} ON CONFLICT DO NOTHING`,
        params
      );
    }
  }

  async getSnapshotMarketOffset(chainId: number): Promise<number> {
    await this.ready;
    const r = await this.pool.query("SELECT snapshot_market_offset FROM morpho_scan_state WHERE chain_id=$1",[chainId]);
    return r.rows[0] ? Number(r.rows[0].snapshot_market_offset) : 0;
  }

  async saveSnapshotMarketOffset(chainId: number, offset: number): Promise<void> {
    await this.ready;
    await this.pool.query(`
      INSERT INTO morpho_scan_state(chain_id,snapshot_market_offset) VALUES($1,$2)
      ON CONFLICT(chain_id) DO UPDATE SET snapshot_market_offset=EXCLUDED.snapshot_market_offset
    `,[chainId,offset]);
  }

  async listBorrowers(chainId: number, marketId: string, limit: number): Promise<MorphoBorrower[]> {
    await this.ready;
    const safeLimit = Math.max(1,Math.min(1000,Math.trunc(limit)));
    const r = await this.pool.query(`
      SELECT address FROM morpho_borrowers WHERE chain_id=$1 AND market_id=$2
      ORDER BY CASE WHEN snapshot_updated_at IS NULL THEN 0 ELSE 1 END,snapshot_updated_at ASC
      LIMIT $3
    `,[chainId,marketId.toLowerCase(),safeLimit]);
    return r.rows.map((row) => ({ address: String(row.address) }));
  }

  async listBorrowerMarketIds(chainId: number): Promise<string[]> {
    await this.ready;
    const r = await this.pool.query(
      "SELECT DISTINCT market_id FROM morpho_borrowers WHERE chain_id=$1 ORDER BY market_id",
      [chainId]
    );
    return r.rows.map((row) => String(row.market_id));
  }

  async saveSnapshot(input: {
    chainId:number;marketId:string;address:string;observedBlock:number;borrowShares:string;
    debtAssets:string;collateralAssets:string;oraclePrice:string;lltvWad:string;healthFactorWad:string;
  }): Promise<void> {
    await this.ready;
    await this.pool.query(`
      UPDATE morpho_borrowers SET observed_block=$1,borrow_shares=$2,debt_assets=$3,
        collateral_assets=$4,oracle_price=$5,lltv_wad=$6,health_factor_wad=$7,
        snapshot_updated_at=NOW()
      WHERE chain_id=$8 AND market_id=$9 AND address=$10
    `,[input.observedBlock,input.borrowShares,input.debtAssets,input.collateralAssets,
      input.oraclePrice,input.lltvWad,input.healthFactorWad,input.chainId,input.marketId.toLowerCase(),input.address.toLowerCase()]);
  }

  async getMonitorStats(chainId: number): Promise<MorphoMonitorStats> {
    await this.ready;
    const [counts, checkpoint] = await Promise.all([
      this.pool.query(`
        SELECT
          (SELECT COUNT(*)::text FROM morpho_markets WHERE chain_id=$1) AS markets,
          (SELECT COUNT(*)::text FROM morpho_borrowers WHERE chain_id=$1) AS borrowers,
          (SELECT COUNT(*)::text FROM morpho_borrowers WHERE chain_id=$1
            AND debt_assets IS NOT NULL AND debt_assets::numeric>0
            AND health_factor_wad IS NOT NULL AND health_factor_wad::numeric<1000000000000000000) AS candidates,
          (SELECT MAX(observed_block)::text FROM morpho_borrowers WHERE chain_id=$1) AS latest_snapshot_block
      `,[chainId]),
      this.getGlobalCheckpoint(chainId)
    ]);
    const row=counts.rows[0] ?? {};
    return {
      marketCount:Number(row.markets ?? 0),
      borrowerCount:Number(row.borrowers ?? 0),
      candidateCount:Number(row.candidates ?? 0),
      latestSnapshotBlock:row.latest_snapshot_block===null || row.latest_snapshot_block===undefined
        ? null : Number(row.latest_snapshot_block),
      checkpoint
    };
  }

  async listLiquidationCandidates(chainId: number, limit: number): Promise<MorphoCandidate[]> {
    await this.ready;
    const safeLimit=Math.max(1,Math.min(100,Math.trunc(limit)));
    const result=await this.pool.query(`
      SELECT market_id AS "marketId",address AS borrower,
        observed_block::text AS "observedBlock",borrow_shares AS "borrowShares",
        debt_assets AS "debtAssets",collateral_assets AS "collateralAssets",
        oracle_price AS "oraclePrice",lltv_wad AS "lltvWad",
        health_factor_wad AS "healthFactorWad",snapshot_updated_at::text AS "snapshotUpdatedAt"
      FROM morpho_borrowers
      WHERE chain_id=$1 AND debt_assets IS NOT NULL AND debt_assets::numeric>0
        AND health_factor_wad IS NOT NULL AND health_factor_wad::numeric<1000000000000000000
      ORDER BY health_factor_wad::numeric ASC
      LIMIT $2
    `,[chainId,safeLimit]);
    return result.rows.map((row)=>({
      marketId:String(row.marketId),borrower:String(row.borrower),
      observedBlock:Number(row.observedBlock),borrowShares:String(row.borrowShares),
      debtAssets:String(row.debtAssets),collateralAssets:String(row.collateralAssets),
      oraclePrice:String(row.oraclePrice),lltvWad:String(row.lltvWad),
      healthFactorWad:String(row.healthFactorWad),snapshotUpdatedAt:String(row.snapshotUpdatedAt)
    }));
  }

  async close(): Promise<void> {
    await this.ready;
    await this.pool.end();
  }
}
