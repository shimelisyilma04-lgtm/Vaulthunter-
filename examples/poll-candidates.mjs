const baseUrl = (process.env.VAULTHUNTER_API_URL || "https://vaulthunter-core.onrender.com").replace(/\/$/, "");
const lookbackBlocks = Math.max(1, Math.min(500, Number(process.env.VAULTHUNTER_LOOKBACK_BLOCKS || 100)));
const pollMs = Math.max(15_000, Number(process.env.VAULTHUNTER_POLL_MS || 30_000));
const seen = new Set();

async function getJson(path) {
  const response = await fetch(baseUrl + path, { headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body;
}

async function poll() {
  const status = await getJson("/api/v1/status");
  if (!status.rpcConfigured) {
    throw new Error(status.rpcConfigurationError || "VaultHunter has no valid Ethereum RPC configured");
  }

  const scan = await getJson(`/api/v1/scan?lookbackBlocks=${lookbackBlocks}`);
  const fresh = scan.candidates.filter((candidate) => {
    const key = candidate.borrower.toLowerCase() + ":" + candidate.observedBlock;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Keep enrichment bounded so a burst of candidates does not overload AaveKit.
  for (const candidate of fresh.slice(0, 10)) {
    let positions = null;
    try {
      positions = await getJson("/api/v1/positions?user=" + encodeURIComponent(candidate.borrower));
    } catch (error) {
      console.error(JSON.stringify({ event: "position_enrichment_error", borrower: candidate.borrower, message: error instanceof Error ? error.message : String(error) }));
    }
    // This is a read-only candidate notification. Do not submit transactions here.
    console.log(JSON.stringify({
      event: "liquidation_candidate",
      protocol: candidate.protocol,
      chainId: candidate.chainId,
      borrower: candidate.borrower,
      scanHealthFactor: Number(candidate.healthFactorWad) / 1e18,
      totalDebtBase: candidate.totalDebtBase,
      observedBlock: candidate.observedBlock,
      observedAt: new Date().toISOString(),
      positionEnrichment: positions,
      requiresPinnedBlockRevalidation: true
    }));
  }
  if (fresh.length > 10) console.log(JSON.stringify({ event: "enrichment_deferred", count: fresh.length - 10 }));

  console.log(JSON.stringify({
    event: "poll_complete",
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    borrowersDiscovered: scan.borrowersDiscovered,
    accountsChecked: scan.accountsChecked,
    candidates: scan.candidates.length,
    newCandidates: fresh.length
  }));
}

async function main() {
  console.log(`VaultHunter read-only bot connected to ${baseUrl}; execution is disabled.`);
  while (true) {
    try {
      await poll();
    } catch (error) {
      console.error(JSON.stringify({
        event: "poll_error",
        message: error instanceof Error ? error.message : String(error)
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
