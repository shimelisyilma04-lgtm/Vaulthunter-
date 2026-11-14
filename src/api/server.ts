import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { AaveStore } from "../aave/store.js";
import { config } from "../config.js";
import { scanAaveBorrowers } from "../aave/scanner.js";

const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const dashboardPath = join(process.cwd(), "dashboard", "index.html");
let scanCache: { createdAt: number; data: Awaited<ReturnType<typeof scanAaveBorrowers>> } | null = null;
let scanInFlight: Promise<Awaited<ReturnType<typeof scanAaveBorrowers>>> | null = null;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

function limitFrom(url: URL, fallback = 100, max = 500): number {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isInteger(raw) ? Math.max(1, Math.min(max, raw)) : fallback;
}

export function startHttpServer(store: AaveStore): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      res.end();
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { error: "method_not_allowed", message: "VaultHunter API is read-only." });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/healthz") {
        send(res, 200, { ok: true, service: "vaulthunter-api", mode: "read-only" });
        return;
      }
      if (url.pathname === "/api/v1/status") {
        const stats = store.getStats(CHAIN_ID, POOL);
        send(res, 200, {
          chain: "ethereum",
          chainId: CHAIN_ID,
          protocol: "aave-v3",
          poolAddress: POOL,
          mode: "read-only",
          rpcConfigured: Boolean(config.ETHEREUM_RPC_URL),
          indexerEnabled: config.AAVE_INDEXER_ENABLED,
          checkpoint: stats.checkpoint,
          counts: {
            borrowEvents: stats.eventCount,
            knownBorrowers: stats.borrowerCount,
            liquidationEligibleSnapshots: stats.candidateCount
          },
          warning: "Liquidation eligibility is a health-factor snapshot, not proof of a profitable or executable liquidation."
        });
        return;
      }
      if (url.pathname === "/api/v1/scan") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: "Set ETHEREUM_RPC_URL in the service environment." });
          return;
        }
        if (scanCache && Date.now() - scanCache.createdAt < 60000) {
          send(res, 200, { ...scanCache.data, cached: true, source: "live-ethereum-rpc" });
          return;
        }
        if (!scanInFlight) {
          scanInFlight = scanAaveBorrowers(config.ETHEREUM_RPC_URL)
            .then((data) => {
              scanCache = { createdAt: Date.now(), data };
              return data;
            })
            .finally(() => { scanInFlight = null; });
        }
        const data = await scanInFlight;
        send(res, 200, { ...data, cached: false, source: "live-ethereum-rpc" });
        return;
      }
      if (url.pathname === "/api/v1/borrowers" || url.pathname === "/api/v1/candidates") {
        const rows = store.listBorrowerSnapshots(
          CHAIN_ID, POOL, limitFrom(url), url.pathname.endsWith("/candidates")
        );
        send(res, 200, { data: rows, count: rows.length, source: "local-indexer-database" });
        return;
      }
      if (url.pathname === "/api/v1/events") {
        const rows = store.listRecentBorrowEvents(CHAIN_ID, POOL, limitFrom(url, 50, 200));
        send(res, 200, { data: rows, count: rows.length, source: "local-indexer-database" });
        return;
      }
      if (url.pathname === "/") {
        const html = await readFile(dashboardPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (error) {
      send(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  });

  server.listen(config.PORT, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "http_server_listening", port: config.PORT, mode: "read-only" }));
  });
  return server;
}
