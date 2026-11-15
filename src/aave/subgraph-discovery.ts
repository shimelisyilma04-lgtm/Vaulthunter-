const AAVE_V3_ETHEREUM_SUBGRAPH_ID = "Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
export const AAVE_V3_POOL_ADDRESS = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
// Aave protocol-subgraphs documents a 100-entity page size. Stay within that
// limit for nested borrowHistory queries and cap discovery at 1,000 recent events.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface BorrowRow {
  id: string;
  timestamp: string;
  amount: string;
  user: { id: string };
  reserve: { id: string };
}
interface SubgraphResponse {
  data?: { pools?: Array<{ id: string; borrowHistory: BorrowRow[] }> };
  errors?: Array<{ message?: string }>;
}

/**
 * Returns a bounded set of historical Aave V3 borrowers from Aave's official
 * protocol subgraph. This is discovery data only; current account state must
 * be refreshed from Ethereum RPC before ranking or simulation.
 *
 * The sync reads at most 1,000 recent Borrow events. It is intentionally not
 * described as exhaustive historical discovery; use the on-chain indexer and
 * repeated refreshes to maintain the known borrower set.
 */
export async function discoverAaveBorrowersFromSubgraph(apiKey: string): Promise<{
  addresses: string[];
  eventsRead: number;
  pagesRead: number;
  oldestEventTimestamp: number | null;
  newestEventTimestamp: number | null;
  source: "aave-protocol-subgraph-v3";
  completeness: "bounded-recent-history-not-exhaustive";
  retrievedAt: string;
}> {
  if (!apiKey.trim()) throw new Error("A Graph API key is required");
  const endpoint = `https://gateway.thegraph.com/api/${encodeURIComponent(apiKey)}/subgraphs/id/${AAVE_V3_ETHEREUM_SUBGRAPH_ID}`;
  const addresses = new Set<string>();
  const timestamps: number[] = [];
  let eventsRead = 0;
  let pagesRead = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const query = `query VaultHunterBorrowerDiscovery {
      pools(where: { pool: "${AAVE_V3_POOL_ADDRESS}" }, first: 1) {
        id
        borrowHistory(first: ${PAGE_SIZE}, skip: ${skip}, orderBy: timestamp, orderDirection: desc) {
          id
          timestamp
          amount
          user { id }
          reserve { id }
        }
      }
    }`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`The Graph returned HTTP ${response.status}`);
    const payload = await response.json() as SubgraphResponse;
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message ?? "GraphQL error").join("; "));
    }
    const rows = payload.data?.pools?.[0]?.borrowHistory ?? [];
    pagesRead += 1;
    eventsRead += rows.length;
    for (const row of rows) {
      if (/^0x[0-9a-fA-F]{40}$/.test(row.user?.id ?? "")) addresses.add(row.user.id.toLowerCase());
      const timestamp = Number(row.timestamp);
      if (Number.isFinite(timestamp) && timestamp > 0) timestamps.push(timestamp);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return {
    addresses: [...addresses],
    eventsRead,
    pagesRead,
    oldestEventTimestamp: timestamps.length ? Math.min(...timestamps) : null,
    newestEventTimestamp: timestamps.length ? Math.max(...timestamps) : null,
    source: "aave-protocol-subgraph-v3",
    completeness: "bounded-recent-history-not-exhaustive",
    retrievedAt: new Date().toISOString()
  };
}
