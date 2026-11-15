import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { AaveStorePort } from "../aave/store.js";
import { config, rpcConfigError } from "../config.js";
import { scanAaveBorrowers } from "../aave/scanner.js";
import { estimateAaveV3Liquidation } from "../domain/profitability.js";
import { fetchAaveKitPositions } from "../aave/aavekit.js";
import { fetchAaveMarketSnapshot } from "../aave/market.js";
import { quoteUniswapV3BestExactInput, quoteUniswapV3ExactInput } from "../aave/uniswap-quote.js";
import { discoverAaveBorrowersFromSubgraph } from "../aave/subgraph-discovery.js";
import { fetchOnchainAavePositions } from "../aave/onchain-positions.js";

const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const dashboardPath = join(process.cwd(), "dashboard", "index.html");
let scanCache: { createdAt: number; lookbackBlocks: number; data: Awaited<ReturnType<typeof scanAaveBorrowers>> } | null = null;
let marketCache: { createdAt: number; data: Awaited<ReturnType<typeof fetchAaveMarketSnapshot>> } | null = null;
const scanInFlight = new Map<number, Promise<Awaited<ReturnType<typeof scanAaveBorrowers>>>>();
let opportunitiesCache: { createdAt: number; limit: number; data: Record<string, unknown> } | null = null;
const opportunitiesInFlight = new Map<number, Promise<Record<string, unknown>>>();

type RateBucket = { startedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60_000;

function rateLimitFor(pathname: string): { key: string; max: number } {
  if (pathname === "/api/v1/discovery/subgraph") return { key: "subgraph-discovery", max: 2 };
  if (pathname === "/api/v1/opportunities") return { key: "opportunities", max: 5 };
  if (["/api/v1/scan", "/api/v1/quote/uniswap-v3", "/api/v1/quote/uniswap-v3/best", "/api/v1/positions", "/api/v1/positions/onchain"].includes(pathname)) {
    return { key: pathname, max: 30 };
  }
  return { key: "general-api", max: 300 };
}

function rateLimitExceeded(req: IncomingMessage, pathname: string): number | null {
  const forwarded = req.headers["x-forwarded-for"];
  const client = typeof forwarded === "string"
    ? forwarded.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown"
    : req.socket.remoteAddress || "unknown";
  const policy = rateLimitFor(pathname);
  const key = `${client}:${policy.key}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= policy.max) {
    return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
  }
  bucket.count += 1;

  // Bound memory use if callers rotate addresses.
  if (rateBuckets.size > 10_000) {
    for (const [entryKey, entry] of rateBuckets) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(entryKey);
      if (rateBuckets.size <= 8_000) break;
    }
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
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

function lookbackBlocksFrom(url: URL): number {
  const raw = Number(url.searchParams.get("lookbackBlocks") ?? config.AAVE_SCAN_LOOKBACK_BLOCKS);
  return Number.isInteger(raw)
    ? Math.max(1, Math.min(500, raw))
    : config.AAVE_SCAN_LOOKBACK_BLOCKS;
}

export function startHttpServer(store: AaveStorePort): ReturnType<typeof createServer> {
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
    const retryAfter = rateLimitExceeded(req, url.pathname);
    if (retryAfter !== null) {
      res.setHeader("retry-after", String(retryAfter));
      send(res, 429, {
        error: "rate_limited",
        message: "Too many requests. Please wait before retrying.",
        retryAfterSeconds: retryAfter
      });
      return;
    }
    try {
      if (url.pathname === "/healthz") {
        send(res, 200, { ok: true, service: "vaulthunter-api", mode: "read-only" });
        return;
      }
      if (url.pathname === "/api/v1/status") {
        const stats = await store.getStats(CHAIN_ID, POOL);
        send(res, 200, {
          chain: "ethereum",
          chainId: CHAIN_ID,
          protocol: "aave-v3",
          poolAddress: POOL,
          mode: "read-only",
          rpcConfigured: Boolean(config.ETHEREUM_RPC_URL),
          rpcConfigurationError: rpcConfigError,
          indexerEnabled: config.AAVE_INDEXER_ENABLED,
          durableStorageConfigured: Boolean(config.DATABASE_URL),
          storageBackend: config.DATABASE_URL ? "postgresql" : "local-sqlite",
          indexerCoverage: config.AAVE_INDEXER_ENABLED ? "recent-window-plus-live-tail" : "disabled",
          historicalCoverageComplete: false,
          dexQuoteProvider: config.ETHEREUM_RPC_URL ? "uniswap-v3-quoter-v2" : "not-configured",
          historicalDiscoveryProvider: config.AAVE_SUBGRAPH_API_KEY ? "aave-protocol-subgraph-v3" : "not-configured",
          historicalDiscoveryConfigured: Boolean(config.AAVE_SUBGRAPH_API_KEY),
          forkSimulationConfigured: false,
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
      if (url.pathname === "/api/v1/market") {
        if (marketCache && Date.now() - marketCache.createdAt < 30000) {
          send(res, 200, { ...marketCache.data, cached: true });
          return;
        }
        const market = await fetchAaveMarketSnapshot();
        marketCache = { createdAt: Date.now(), data: market };
        send(res, 200, { ...market, cached: false });
        return;
      }
      if (url.pathname === "/api/v1/positions/onchain") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for block-pinned reserve positions." });
          return;
        }
        const user = url.searchParams.get("user")?.trim();
        if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
          send(res, 400, { error: "invalid_user_address", message: "Provide a valid 20-byte Ethereum address in the user query parameter." });
          return;
        }
        try {
          const positions = await fetchOnchainAavePositions(
            config.ETHEREUM_RPC_URL, user, config.AAVE_INDEXER_CONFIRMATIONS
          );
          send(res, 200, positions);
        } catch (error) {
          send(res, 502, { error: "onchain_positions_unavailable", message: error instanceof Error ? error.message : "Aave on-chain position lookup failed" });
        }
        return;
      }
      if (url.pathname === "/api/v1/positions") {
        const user = url.searchParams.get("user")?.trim();
        if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
          send(res, 400, { error: "invalid_user_address", message: "Provide a valid 20-byte Ethereum address in the user query parameter." });
          return;
        }
        try {
          const positions = await fetchAaveKitPositions(user);
          send(res, 200, positions);
        } catch (error) {
          send(res, 502, { error: "aavekit_unavailable", message: error instanceof Error ? error.message : "AaveKit request failed" });
        }
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


      if (url.pathname === "/api/v1/discovery/subgraph") {
        if (!config.AAVE_SUBGRAPH_API_KEY) {
          send(res, 503, {
            error: "subgraph_not_configured",
            message: "Set AAVE_SUBGRAPH_API_KEY in the Render environment to enable Aave official subgraph borrower discovery. Do not send the key in chat.",
            source: "aave-protocol-subgraph-v3"
          });
          return;
        }
        try {
          const discovery = await discoverAaveBorrowersFromSubgraph(config.AAVE_SUBGRAPH_API_KEY);
          send(res, 200, discovery);
        } catch (error) {
          send(res, 502, { error: "subgraph_unavailable", message: error instanceof Error ? error.message : "Aave subgraph query failed" });
        }
        return;
      }
      if (url.pathname === "/api/v1/opportunities") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for live opportunity revalidation." });
          return;
        }
        const requestedLimit = limitFrom(url, 10, 20);
        if (opportunitiesCache && opportunitiesCache.limit === requestedLimit &&
            Date.now() - opportunitiesCache.createdAt < 15_000) {
          send(res, 200, { ...opportunitiesCache.data, cached: true });
          return;
        }
        let pending = opportunitiesInFlight.get(requestedLimit);
        if (!pending) {
          pending = (async () => {
            // Only recheck accounts previously flagged below HF 1 by the indexer.
            // Each account is then refreshed from Aave at its own confirmed block.
            const flagged = await store.listBorrowerSnapshots(CHAIN_ID, POOL, requestedLimit, true);
            const checked: Array<Record<string, unknown>> = [];
            for (let offset = 0; offset < flagged.length; offset += 3) {
              const batch = flagged.slice(offset, offset + 3);
              const results = await Promise.all(batch.map(async (row) => {
                try {
                  const position = await fetchOnchainAavePositions(
                    config.ETHEREUM_RPC_URL!, row.address, config.AAVE_INDEXER_CONFIRMATIONS
                  );
                  return {
                    user: position.user,
                    healthFactor: position.healthFactor,
                    healthFactorWad: position.healthFactorWad,
                    userEModeCategory: position.userEModeCategory,
                    baseCurrency: position.baseCurrency,
                    baseCurrencyUnit: position.baseCurrencyUnit,
                    observedBlock: position.observedBlock,
                    totalDebtBase: position.totalDebtBase,
                    totalCollateralBase: position.totalCollateralBase,
                    liquidationEligibleAtBlock: position.liquidationEligibleAtBlock,
                    screeningPairs: position.screeningPairs,
                    source: position.source
                  } as Record<string, unknown>;
                } catch (error) {
                  return {
                    user: row.address,
                    recheckError: error instanceof Error ? error.message : "On-chain recheck failed"
                  } as Record<string, unknown>;
                }
              }));
              checked.push(...results);
            }
            const data = {
              source: "aave-v3-confirmed-block-revalidation",
              checkedAccounts: checked.length,
              eligibleAccounts: checked.filter((row) => row.liquidationEligibleAtBlock === true).length,
              pairCount: checked.reduce((sum, row) => sum + (Array.isArray(row.screeningPairs) ? row.screeningPairs.length : 0), 0),
              data: checked,
              warning: "Only previously discovered accounts with an earlier HF-below-1 snapshot are rechecked. Each account is read at its own confirmed block. Pairs include Aave oracle base-currency values at each wallet\u2019s confirmed block, but eMode-specific price overrides, close factor, protocol fee, flash liquidity, DEX route, gas, MEV and complete transaction simulation remain unverified. No transaction is signed or submitted."
            };
            opportunitiesCache = { createdAt: Date.now(), limit: requestedLimit, data };
            return data;
          })().finally(() => { opportunitiesInFlight.delete(requestedLimit); });
          opportunitiesInFlight.set(requestedLimit, pending);
        }
        const data = await pending;
        send(res, 200, { ...data, cached: false });
        return;
      }
      if (url.pathname === "/api/v1/risk") {
        const rows = await store.listBorrowerSnapshots(CHAIN_ID, POOL, limitFrom(url), false);
        const now = Date.now();
        const data = rows.map((row) => {
          const healthFactor = row.healthFactorWad === null ? null : Number(row.healthFactorWad) / 1e18;
          const snapshotAgeSeconds = row.snapshotUpdatedAt
            ? Math.max(0, Math.floor((now - Date.parse(row.snapshotUpdatedAt)) / 1000))
            : null;
          const riskBand = healthFactor === null ? "unknown"
            : healthFactor < 1 ? "liquidation-eligible-at-snapshot"
            : healthFactor < 1.02 ? "critical"
            : healthFactor < 1.05 ? "high"
            : healthFactor < 1.1 ? "watch" : "lower";
          return { ...row, healthFactor, riskBand, snapshotAgeSeconds,
            snapshotFresh: snapshotAgeSeconds !== null && snapshotAgeSeconds <= 60 };
        }).sort((a, b) => {
          if (a.healthFactor === null) return 1;
          if (b.healthFactor === null) return -1;
          return a.healthFactor - b.healthFactor;
        }).map((row, index) => ({ rank: index + 1, ...row }));
        send(res, 200, {
          data, count: data.length,
          source: "on-chain-account-snapshots-from-indexed-borrowers",
          ranking: "lowest-health-factor-first",
          warning: "This ranks only borrowers already discovered by the configured event indexer. Historical market coverage is incomplete; stale snapshots must be refreshed at a pinned block. Risk bands are screening labels, not liquidation or profitability guarantees."
        });
        return;
      }
      if (url.pathname === "/api/v1/quote/uniswap-v3/best") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for on-chain Uniswap quotes." });
          return;
        }
        const tokenIn = url.searchParams.get("tokenIn") ?? "";
        const tokenOut = url.searchParams.get("tokenOut") ?? "";
        const amountIn = url.searchParams.get("amountIn") ?? "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(tokenIn) ||
            !/^0x[0-9a-fA-F]{40}$/.test(tokenOut) ||
            !/^[0-9]+$/.test(amountIn) || amountIn.length > 78) {
          send(res, 400, { error: "invalid_quote_parameters", message: "Provide tokenIn, tokenOut, and positive integer amountIn in token base units." });
          return;
        }
        try {
          const quote = await quoteUniswapV3BestExactInput(config.ETHEREUM_RPC_URL, { tokenIn, tokenOut, amountIn });
          send(res, 200, quote);
        } catch (error) {
          send(res, 502, { error: "quote_unavailable", message: error instanceof Error ? error.message : "Uniswap fee-tier quote scan failed" });
        }
        return;
      }
      if (url.pathname === "/api/v1/quote/uniswap-v3") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for an on-chain Uniswap quote." });
          return;
        }
        const tokenIn = url.searchParams.get("tokenIn") ?? "";
        const tokenOut = url.searchParams.get("tokenOut") ?? "";
        const amountIn = url.searchParams.get("amountIn") ?? "";
        const fee = Number(url.searchParams.get("fee"));
        if (!/^0x[0-9a-fA-F]{40}$/.test(tokenIn) ||
            !/^0x[0-9a-fA-F]{40}$/.test(tokenOut) ||
            !/^[0-9]+$/.test(amountIn) || amountIn.length > 78 ||
            !Number.isInteger(fee)) {
          send(res, 400, { error: "invalid_quote_parameters", message: "Provide tokenIn, tokenOut, positive integer amountIn in token base units, and fee tier 100, 500, 3000, or 10000." });
          return;
        }
        try {
          const quote = await quoteUniswapV3ExactInput(config.ETHEREUM_RPC_URL, { tokenIn, tokenOut, amountIn, fee });
          send(res, 200, quote);
        } catch (error) {
          send(res, 502, { error: "quote_unavailable", message: error instanceof Error ? error.message : "Uniswap quote failed" });
        }
        return;
      }
      if (url.pathname === "/api/v1/simulation/status") {
        send(res, 200, {
          configured: false, executionEnabled: false, status: "not_configured",
          required: ["forked Ethereum state at a pinned block", "complete liquidation transaction calldata", "flash-loan and DEX callback path", "isolated simulation runner and gas accounting"],
          warning: "VaultHunter does not yet simulate the complete liquidation transaction. A Uniswap quote alone is not a simulation. Do not treat a positive estimate or quote as executable."
        });
        return;
      }
      if (url.pathname === "/api/v1/scan") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Set ETHEREUM_RPC_URL to the full HTTPS endpoint from your Ethereum RPC provider." });
          return;
        }
        const lookbackBlocks = lookbackBlocksFrom(url);
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
        const rows = await store.listBorrowerSnapshots(
          CHAIN_ID, POOL, limitFrom(url), url.pathname.endsWith("/candidates")
        );
        send(res, 200, { data: rows, count: rows.length, source: "local-indexer-database" });
        return;
      }
      if (url.pathname === "/api/v1/events") {
        const rows = await store.listRecentBorrowEvents(CHAIN_ID, POOL, limitFrom(url, 50, 200));
        send(res, 200, { data: rows, count: rows.length, source: "local-indexer-database" });
        return;
      }
      if (url.pathname === "/") {
        const html = await readFile(dashboardPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()" });
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
