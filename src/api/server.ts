import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { AaveStore } from "../aave/store.js";
import { config, rpcConfigError } from "../config.js";
import { scanAaveBorrowers } from "../aave/scanner.js";
import { estimateAaveV3Liquidation } from "../domain/profitability.js";

const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const dashboardPath = join(process.cwd(), "dashboard", "index.html");
let scanCache: { createdAt: number; lookbackBlocks: number; data: Awaited<ReturnType<typeof scanAaveBorrowers>> } | null = null;
const scanInFlight = new Map<number, Promise<Awaited<ReturnType<typeof scanAaveBorrowers>>>>();

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
          rpcConfigurationError: rpcConfigError,
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
      if (url.pathname === "/api/v1/estimate") {
        const required = ["healthFactor", "totalDebtUsd", "debtReserveUsd", "collateralReserveUsd", "collateralAvailableUsd", "liquidationBonusBps", "gasCostUsd"] as const;
        const values: Record<string, number> = {};
        for (const key of required) {
          const raw = url.searchParams.get(key);
          if (raw === null || raw.trim() === "" || !Number.isFinite(Number(raw))) {
            send(res, 400, { error: "invalid_parameter", message: "Provide a finite numeric " + key + " query parameter." });
            return;
          }
          values[key] = Number(raw);
        }
        const optional = ["flashLoanFeeBps", "swapFeeBps", "slippageBps", "protocolFeeBps", "safetyBufferBps"] as const;
        for (const key of optional) {
          const raw = url.searchParams.get(key);
          if (raw !== null) {
            if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
              send(res, 400, { error: "invalid_parameter", message: "The " + key + " parameter must be numeric." });
              return;
            }
            values[key] = Number(raw);
          }
        }
        try {
          const estimate = estimateAaveV3Liquidation({
            healthFactor: values.healthFactor!, totalDebtUsd: values.totalDebtUsd!,
            debtReserveUsd: values.debtReserveUsd!, collateralReserveUsd: values.collateralReserveUsd!,
            collateralAvailableUsd: values.collateralAvailableUsd!, liquidationBonusBps: values.liquidationBonusBps!,
            gasCostUsd: values.gasCostUsd!, flashLoanFeeBps: values.flashLoanFeeBps ?? 0,
            swapFeeBps: values.swapFeeBps ?? 0, slippageBps: values.slippageBps ?? 0,
            protocolFeeBps: values.protocolFeeBps ?? 0, safetyBufferBps: values.safetyBufferBps ?? 500
          });
          send(res, 200, { ...estimate, source: "caller-supplied-screening-inputs", executionEnabled: false });
        } catch (error) {
          send(res, 400, { error: "invalid_estimate_input", message: error instanceof Error ? error.message : "Invalid estimate input" });
        }
        return;
      }
      if (url.pathname === "/api/v1/scan") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Set ETHEREUM_RPC_URL to the full HTTPS endpoint from your Ethereum RPC provider." });
          return;
        }
        const lookbackBlocks = limitFrom(url, config.AAVE_SCAN_LOOKBACK_BLOCKS, 10000);
        if (scanCache && scanCache.lookbackBlocks === lookbackBlocks && Date.now() - scanCache.createdAt < 60000) {
          send(res, 200, { ...scanCache.data, cached: true, source: "live-ethereum-rpc" });
          return;
        }
        let pending = scanInFlight.get(lookbackBlocks);
        if (!pending) {
          pending = scanAaveBorrowers(config.ETHEREUM_RPC_URL, lookbackBlocks)
            .then((data) => {
              scanCache = { createdAt: Date.now(), lookbackBlocks, data };
              return data;
            })
            .finally(() => { scanInFlight.delete(lookbackBlocks); });
          scanInFlight.set(lookbackBlocks, pending);
        }
        const data = await pending;
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
