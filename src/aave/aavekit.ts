const AAVE_V3_ETHEREUM_MARKET = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVEKIT_GRAPHQL_URL = "https://api.v3.aave.com/graphql";

interface PositionAsset {
  market: { name: string; address: string; chain: { chainId: number } };
  currency: { symbol: string; name: string };
  balance?: { amount: { value: string }; usd: string };
  debt?: { amount: { value: string }; usd: string };
  isCollateral?: boolean;
  canBeCollateral?: boolean;
}

interface AaveKitResponse {
  data?: {
    userSupplies?: PositionAsset[];
    userBorrows?: PositionAsset[];
    userMarketState?: Record<string, unknown> | null;
  };
  errors?: Array<{ message?: string }>;
}

/**
 * Fetches the official AaveKit read-only view for a known Ethereum V3 borrower.
 * AaveKit is an indexed API: its response is useful for enrichment, but is not
 * guaranteed to be pinned to the same block as an RPC scan.
 */
export async function fetchAaveKitPositions(userAddress: string): Promise<{
  user: string;
  market: string;
  chainId: 1;
  supplies: PositionAsset[];
  borrows: PositionAsset[];
  marketState: Record<string, unknown> | null;
  source: "aavekit-graphql";
  freshness: "provider-indexed-not-pinned";
  warning: string;
}> {
  const user = userAddress;
  const query = `query {
    userSupplies(request: {
      markets: [{ address: "${AAVE_V3_ETHEREUM_MARKET}", chainId: 1 }]
      user: "${user}"
    }) {
      market { name address chain { chainId } }
      currency { symbol name }
      balance { amount { value } usd }
      isCollateral
      canBeCollateral
    }
    userBorrows(request: {
      markets: [{ address: "${AAVE_V3_ETHEREUM_MARKET}", chainId: 1 }]
      user: "${user}"
    }) {
      market { name address chain { chainId } }
      currency { symbol name }
      debt { amount { value } usd }
    }
    userMarketState(request: {
      market: "${AAVE_V3_ETHEREUM_MARKET}"
      user: "${user}"
      chainId: 1
    }) {
      netWorth
      healthFactor
      totalCollateralBase
      totalDebtBase
      availableBorrowsBase
      currentLiquidationThreshold { value formatted }
      ltv { value formatted }
      eModeEnabled
    }
  }`;

  const response = await fetch(AAVEKIT_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    throw new Error("AaveKit returned HTTP " + response.status);
  }

  const payload = await response.json() as AaveKitResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message ?? "GraphQL error").join("; "));
  }
  if (!payload.data) {
    throw new Error("AaveKit returned no position data");
  }

  return {
    user,
    market: AAVE_V3_ETHEREUM_MARKET,
    chainId: 1,
    supplies: payload.data.userSupplies ?? [],
    borrows: payload.data.userBorrows ?? [],
    marketState: payload.data.userMarketState ?? null,
    source: "aavekit-graphql",
    freshness: "provider-indexed-not-pinned",
    warning: "AaveKit data may be cached and is not guaranteed to share the RPC scan's block. Revalidate positions and health factor directly on-chain at one pinned block before estimating or executing."
  };
}
