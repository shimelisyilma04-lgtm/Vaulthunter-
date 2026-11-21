import { describe, expect, it } from "vitest";
import { getRateLimitClientIdentity, startHttpServer } from "./server.js";

describe("getRateLimitClientIdentity", () => {
  it("uses Render's trusted CF-Connecting-IP header", () => {
    const req = {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("203.0.113.7");
  });

  it("ignores caller-controlled X-Forwarded-For and falls back to socket IP", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("10.0.0.1");
  });

  it("rejects malformed Cloudflare client IP values", () => {
    const req = {
      headers: { "cf-connecting-ip": "not-an-ip" },
      socket: { remoteAddress: "10.0.0.1" }
    } as never;
    expect(getRateLimitClientIdentity(req)).toBe("10.0.0.1");
  });
});

describe("Morpho monitoring API", () => {
  it("serves durable indexer status and read-only candidate snapshots", async () => {
    const morphoStore = {
      getMonitorStats: async () => ({
        marketCount: 12, borrowerCount: 34, candidateCount: 2,
        refreshedLast2Minutes: 30, latestSnapshotAt: new Date().toISOString(),
        latestSnapshotBlock: 26461785,
        checkpoint: { lastBlock: 26461785, lastBlockHash: "0xabc" }
      }),
      listRiskPositions: async () => [{ marketId: "0xmarket", borrower: "0x0000000000000000000000000000000000000002", observedBlock: 26461785, borrowShares: "10", debtAssets: "11", collateralAssets: "20", oraclePrice: "2000000000000000000000000000000000000", lltvWad: "860000000000000000", healthFactorWad: "1040000000000000000", snapshotUpdatedAt: new Date().toISOString() }],
      listLiquidationCandidates: async () => [{
        marketId: "0xmarket", borrower: "0x0000000000000000000000000000000000000001",
        observedBlock: 26461785, borrowShares: "10", debtAssets: "11",
        collateralAssets: "20", oraclePrice: "2000000000000000000000000000000000000",
        lltvWad: "860000000000000000", healthFactorWad: "900000000000000000",
        snapshotUpdatedAt: new Date().toISOString()
      }]
    } as never;
    const server = startHttpServer({} as never, morphoStore);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const status = await fetch(`${base}/api/v1/morpho/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        protocol: "morpho-blue", chainId: 1, mode: "read-only",
        counts: { marketsDiscovered: 12, borrowersDiscovered: 34, liquidationEligibleFreshSnapshots: 2, refreshedLast2Minutes: 30 },
        candidateFreshnessWindowSeconds: 60
      });
      const risk = await fetch(`${base}/api/v1/morpho/risk?limit=5`);
      expect(risk.status).toBe(200);
      expect(await risk.json()).toMatchObject({ count: 1, executionEnabled: false, ranking: "lowest-health-factor-first", data: [{ rank: 1, healthFactor: 1.04, riskClassification: "critical", liquidationEligibleAtSnapshot: false }] });
      const candidates = await fetch(`${base}/api/v1/morpho/candidates?limit=5`);
      expect(candidates.status).toBe(200);
      expect(await candidates.json()).toMatchObject({
        count: 1, freshCount: 1, staleCount: 0, executionEnabled: false, ranking: "lowest-health-factor-first"
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("read-only API boundary", () => {
  it("serves health and rejects unsupported write methods", async () => {
    const server = startHttpServer({} as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: "read-only" });

      const write = await fetch(`${base}/api/v1/borrowers`, { method: "DELETE" });
      expect(write.status).toBe(405);
      expect(await write.json()).toMatchObject({ error: "method_not_allowed" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
