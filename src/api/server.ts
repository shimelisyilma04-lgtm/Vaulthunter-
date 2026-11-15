import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { AaveStorePort } from "../aave/store.js";
import { config, rpcConfigError } from "../config.js";
import { scanAaveBorrowers } from "../aave/scanner.js";
import { estimateAaveV3Liquidation } from "../domain/profitability.js";
import { estimateExecutionCosts } from "../domain/execution-costs.js";
import { fetchAaveKitPositions } from "../aave/aavekit.js";
import { fetchAaveMarketSnapshot } from "../aave/market.js";
import { quoteUniswapV3BestExactInput, quoteUniswapV3BestPath, quoteUniswapV3ExactInput } from "../aave/uniswap-quote.js";
import { simulateAaveLiquidationCall, simulateForkCall } from "../aave/fork-simulation.js";
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
  if (pathname === "/api/v1/simulation/fork" || pathname === "/api/v1/simulation/aave-liquidation") return { key: "fork-simulation", max: 5 };
  if (pathname === "/api/v1/opportunities" || pathname === "/api/v1/opportunities/estimate") return { key: "opportunities", max: 5 };
  if (["/api/v1/scan", "/api/v1/quote/uniswap-v3", "/api/v1/quote/uniswap-v3/best", "/api/v1/quote/uniswap-v3/path", "/api/v1/positions", "/api/v1/positions/onchain"].includes(pathname)) {
    return { key: pathname, max: 30 };
  }
  return { key: "general-api", max: 300 };
}

function rateLimitExceeded(req: IncomingMessage, pathname: string): number | null {
  // Do not trust caller-supplied X-Forwarded-For values for rate-limit identity.
  const client = req.socket.remoteAddress || "unknown";
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
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


async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20_000) throw new Error("Request body exceeds the 20 KB limit");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function startHttpServer(store: AaveStorePort): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://" + (req.headers.host ?? "localhost"));
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization"
      });
      res.end();
      return;
    }
    const isForkSimulationPost = req.method === "POST" && ["/api/v1/simulation/fork", "/api/v1/simulation/aave-liquidation"].includes(url.pathname);
    if (req.method !== "GET" && !isForkSimulationPost) {
      send(res, 405, { error: "method_not_allowed", message: "Only GET and the read-only fork simulation POST endpoint are supported." });
      return;
    }
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
      if (isForkSimulationPost) {
        if (!config.ETHEREUM_FORK_RPC_URL || !config.VAULTHUNTER_SIMULATION_API_TOKEN) {
          send(res, 503, { error: "fork_not_configured", message: "Set ETHEREUM_FORK_RPC_URL and a strong VAULTHUNTER_SIMULATION_API_TOKEN. Use an isolated Anvil/Hardhat fork, never a mainnet transaction broadcaster." });
          return;
        }
        const suppliedToken = req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : "";
        const expectedToken = Buffer.from(config.VAULTHUNTER_SIMULATION_API_TOKEN);
        const receivedToken = Buffer.from(suppliedToken);
        if (receivedToken.length !== expectedToken.length || !timingSafeEqual(receivedToken, expectedToken)) {
          send(res, 401, { error: "unauthorized", message: "A valid simulation bearer token is required." });
          return;
        }
        if (!String(req.headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
          send(res, 415, { error: "unsupported_media_type", message: "Use application/json." });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          send(res, 400, { error: "invalid_request_body", message: error instanceof Error ? error.message : "Invalid JSON request body" });
          return;
        }
        if (url.pathname === "/api/v1/simulation/aave-liquidation") {
          if (typeof body.collateralAsset !== "string" || typeof body.debtAsset !== "string" ||
              typeof body.user !== "string" || typeof body.debtToCover !== "string" ||
              typeof body.receiveAToken !== "boolean" || typeof body.from !== "string") {
            send(res, 400, { error: "invalid_aave_simulation_request", message: "Provide collateralAsset, debtAsset, user, debtToCover, receiveAToken and from." });
            return;
          }
          try {
            const result = await simulateAaveLiquidationCall(config.ETHEREUM_FORK_RPC_URL, {
              collateralAsset: body.collateralAsset,
              debtAsset: body.debtAsset,
              user: body.user,
              debtToCover: body.debtToCover,
              receiveAToken: body.receiveAToken,
              from: body.from
            }, config.AAVE_INDEXER_CONFIRMATIONS);
            send(res, 200, result);
          } catch (error) {
            send(res, 422, { error: "aave_fork_simulation_failed", message: error instanceof Error ? error.message.slice(0, 500) : "Aave liquidation call reverted or simulation failed", transactionSubmitted: false });
          }
          return;
        }
        if (typeof body.to !== "string" || typeof body.data !== "string" ||
            (body.value !== undefined && typeof body.value !== "string") ||
            (body.from !== undefined && typeof body.from !== "string")) {
          send(res, 400, { error: "invalid_simulation_request", message: "Provide to and data strings, with optional value and from strings." });
          return;
        }
        try {
          const result = await simulateForkCall(config.ETHEREUM_FORK_RPC_URL, {
            to: body.to, data: body.data,
            ...(typeof body.value === "string" ? { value: body.value } : {}),
            ...(typeof body.from === "string" ? { from: body.from } : {})
          }, config.AAVE_INDEXER_CONFIRMATIONS);
          send(res, 200, result);
        } catch (error) {
          send(res, 422, { error: "fork_simulation_failed", message: error instanceof Error ? error.message.slice(0, 500) : "Fork call reverted or simulation failed", transactionSubmitted: false });
        }
        return;
      }
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
          forkSimulationConfigured: Boolean(config.ETHEREUM_FORK_RPC_URL && config.VAULTHUNTER_SIMULATION_API_TOKEN),
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
      if (url.pathname === "/api/v1/execution-costs") {
        const integerKeys = [
          "grossProfitUsdCents", "gasLimit", "maxFeePerGasWei", "nativeAssetPriceUsdWad",
          "flashLoanPrincipalUsdCents", "swapNotionalUsdCents", "builderFeeUsdCents"
        ] as const;
        const values: Record<string, string> = {};
        for (const key of integerKeys) {
          const raw = url.searchParams.get(key);
          if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 100) {
            send(res, 400, { error: "invalid_parameter", message: key + " must be a non-negative integer string." });
            return;
          }
          values[key] = raw;
        }
        const bpsKeys = ["flashLoanFeeBps", "swapFeeBps", "slippageBps", "safetyBufferBps"] as const;
        const bps: Record<string, number> = {};
        for (const key of bpsKeys) {
          const raw = url.searchParams.get(key) ?? "0";
          if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) >= 10000) {
            send(res, 400, { error: "invalid_parameter", message: key + " must be an integer from 0 to 9999." });
            return;
          }
          bps[key] = Number(raw);
        }
        try {
          const result = estimateExecutionCosts({
            grossProfitUsdCents: values.grossProfitUsdCents!,
            gasLimit: values.gasLimit!,
            maxFeePerGasWei: values.maxFeePerGasWei!,
            nativeAssetPriceUsdWad: values.nativeAssetPriceUsdWad!,
            flashLoanPrincipalUsdCents: values.flashLoanPrincipalUsdCents!,
            flashLoanFeeBps: bps.flashLoanFeeBps!,
            swapNotionalUsdCents: values.swapNotionalUsdCents!,
            swapFeeBps: bps.swapFeeBps!,
            slippageBps: bps.slippageBps!,
            builderFeeUsdCents: values.builderFeeUsdCents!,
            safetyBufferBps: bps.safetyBufferBps!
          });
          send(res, 200, { ...result, source: "caller-supplied-integer-cost-inputs", executionEnabled: false });
        } catch (error) {
          send(res, 400, { error: "invalid_execution_cost_input", message: error instanceof Error ? error.message : "Invalid execution-cost input" });
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
      if (url.pathname === "/api/v1/opportunities/estimate") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for Aave liquidation screening." });
          return;
        }
        const user = url.searchParams.get("user")?.trim() ?? "";
        const gasCostRaw = url.searchParams.get("gasCostUsd");
        if (!/^0x[0-9a-fA-F]{40}$/.test(user) || gasCostRaw === null ||
            gasCostRaw.trim() === "" || !Number.isFinite(Number(gasCostRaw)) || Number(gasCostRaw) < 0) {
          send(res, 400, { error: "invalid_estimate_parameters", message: "Provide a valid user address and non-negative gasCostUsd." });
          return;
        }
        const optionalKeys = ["flashLoanFeeBps", "swapFeeBps", "slippageBps", "safetyBufferBps"] as const;
        const optional: Record<string, number> = {};
        for (const key of optionalKeys) {
          const raw = url.searchParams.get(key);
          if (raw !== null) {
            if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) >= 10000) {
              send(res, 400, { error: "invalid_estimate_parameters", message: key + " must be an integer from 0 to 9999." });
              return;
            }
            optional[key] = Number(raw);
          }
        }
        try {
          const position = await fetchOnchainAavePositions(config.ETHEREUM_RPC_URL, user, config.AAVE_INDEXER_CONFIRMATIONS);
          if (position.baseCurrency.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
            send(res, 409, { error: "unsupported_base_currency", message: "Automatic USD estimates are disabled because this Aave market does not report USD as its base currency.", user: position.user, baseCurrency: position.baseCurrency });
            return;
          }
          if (!position.eModeAwareCalculationReady) {
            send(res, 409, { error: "emode_price_source_unresolved", message: "This user's eMode category overrides the price source. The category price feed is not yet safely normalized into the Aave base currency, so profitability estimates are withheld.", user: position.user, eModeCategoryData: position.eModeCategoryData });
            return;
          }
          const unit = Number(BigInt(position.baseCurrencyUnit));
          const toUsd = (value: string) => Number(BigInt(value)) / unit;
          const estimates = position.screeningPairs.map((pair) => {
            const effectiveBonusBps = Number(BigInt(pair.effectiveLiquidationBonus)) - 10000;
            const protocolFeeBps = Number(BigInt(pair.liquidationProtocolFee));
            const estimate = estimateAaveV3Liquidation({
              healthFactor: position.healthFactor ?? 0,
              totalDebtUsd: toUsd(position.totalDebtBase),
              debtReserveUsd: toUsd(pair.debtValueBase),
              collateralReserveUsd: toUsd(pair.collateralValueBase),
              collateralAvailableUsd: toUsd(pair.collateralValueBase),
              liquidationBonusBps: effectiveBonusBps,
              gasCostUsd: Number(gasCostRaw),
              flashLoanFeeBps: optional.flashLoanFeeBps ?? 0,
              swapFeeBps: optional.swapFeeBps ?? 0,
              slippageBps: optional.slippageBps ?? 0,
              protocolFeeBps,
              safetyBufferBps: optional.safetyBufferBps ?? 500
            });
            return {
              collateralAsset: pair.collateralAsset,
              collateralSymbol: pair.collateralSymbol,
              debtAsset: pair.debtAsset,
              debtSymbol: pair.debtSymbol,
              eModeCompatible: pair.eModeCompatible,
              effectiveLiquidationBonusBps: effectiveBonusBps,
              protocolFeeBps,
              ...estimate
            };
          });
          send(res, 200, {
            user: position.user,
            observedBlock: position.observedBlock,
            healthFactor: position.healthFactor,
            userEModeCategory: position.userEModeCategory,
            eModeAwareCalculationReady: position.eModeAwareCalculationReady,
            baseCurrency: position.baseCurrency,
            source: "aave-v3-confirmed-block-reserve-and-oracle-data",
            count: estimates.length,
            estimates,
            executionEnabled: false,
            warning: "These estimates use confirmed-block Aave reserve balances, oracle values, reserve eMode membership, and category liquidation bonus when safely applicable. They remain screening estimates: exact liquidation close-factor edge cases, minimum residual debt, flash-loan availability, live route, gas and MEV must be validated by complete fork simulation."
          });
        } catch (error) {
          send(res, 502, { error: "opportunity_estimate_failed", message: error instanceof Error ? error.message : "Aave opportunity estimate failed" });
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
                    eModeCategoryData: position.eModeCategoryData,
                    eModeAwareCalculationReady: position.eModeAwareCalculationReady,
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
              warning: "Only previously discovered accounts with an earlier HF-below-1 snapshot are rechecked. Each account is read at its own confirmed block. Pairs include Aave oracle base-currency values at each wallet\u2019s confirmed block, but non-zero eMode price-source overrides, pair-specific close factor, flash liquidity, DEX route, gas, MEV and complete transaction simulation remain unverified. No transaction is signed or submitted."
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
      if (url.pathname === "/api/v1/quote/uniswap-v3/path") {
        if (!config.ETHEREUM_RPC_URL) {
          send(res, 503, { error: "rpc_not_configured", message: rpcConfigError ?? "Ethereum RPC is required for multi-hop Uniswap quotes." });
          return;
        }
        const tokensRaw = url.searchParams.get("tokens") ?? "";
        const tokens = tokensRaw.split(",").map((token) => token.trim()).filter(Boolean);
        const amountIn = url.searchParams.get("amountIn") ?? "";
        if (tokens.length < 2 || tokens.length > 4 ||
            tokens.some((token) => !/^0x[0-9a-fA-F]{40}$/.test(token)) ||
            !/^[0-9]+$/.test(amountIn) || amountIn.length > 78 || BigInt(amountIn || "0") <= 0n) {
          send(res, 400, { error: "invalid_path_quote_parameters", message: "Provide 2–4 comma-separated token addresses and positive integer amountIn in input-token base units." });
          return;
        }
        try {
          const quote = await quoteUniswapV3BestPath(config.ETHEREUM_RPC_URL, { tokens, amountIn });
          send(res, 200, quote);
        } catch (error) {
          send(res, 502, { error: "path_quote_unavailable", message: error instanceof Error ? error.message : "Uniswap path quote scan failed" });
        }
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
            !/^[0-9]+$/.test(amountIn) || amountIn.length > 78 || BigInt(amountIn || "0") <= 0n) {
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
          configured: Boolean(config.ETHEREUM_FORK_RPC_URL && config.VAULTHUNTER_SIMULATION_API_TOKEN),
          status: config.ETHEREUM_FORK_RPC_URL && config.VAULTHUNTER_SIMULATION_API_TOKEN ? "fork_rpc_configured" : "awaiting_fork_configuration",
          simulationEndpoints: ["POST /api/v1/simulation/fork", "POST /api/v1/simulation/aave-liquidation"],
          executionEnabled: false,
          transactionSubmissionEnabled: false,
          required: ["ETHEREUM_FORK_RPC_URL pointing to an isolated Ethereum-mainnet fork", "complete liquidation transaction calldata from a separately audited executor", "flash-loan and DEX callback path deployed on that fork"],
          warning: "The fork endpoint performs eth_call and eth_estimateGas only. It does not deploy an executor, construct liquidation calldata, sign transactions, or submit transactions."
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
