const AAVE_V3_ETHEREUM_MARKET = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const AAVEKIT_GRAPHQL_URL = "https://api.v3.aave.com/graphql";

export interface AaveMarketReserve {
  underlyingToken: { address: string; name: string; symbol: string; decimals: number };
  size: { usd: string; amount: { value: string } };
  usdExchangeRate: string;
  usdOracleAddress: string;
  isFrozen: boolean;
  isPaused: boolean;
  flashLoanEnabled: boolean;
  supplyInfo: {
    liquidationBonus: { raw: string; decimals: number; value: string; formatted: string };
    liquidationThreshold: { raw: string; decimals: number; value: string; formatted: string };
    canBeCollateral: boolean;
  };
  borrowInfo: {
    availableLiquidity: { usd: string; amount: { value: string } };
    borrowingState: string;
  } | null;
}

export interface AaveMarketSnapshot {
  market: {
    name: string;
    address: string;
    chain: { name: string; chainId: number };
    totalMarketSize: string;
    totalAvailableLiquidity: string;
  };
  reserves: AaveMarketReserve[];
  source: "aavekit-graphql";
  freshness: "provider-indexed-not-pinned";
  retrievedAt: string;
  warning: string;
}

interface GraphqlPayload {
  data?: { market?: AaveMarketSnapshot["market"] & { reserves?: AaveMarketReserve[] } | null };
  errors?: Array<{ message?: string }>;
}

/**
 * Fetches the current Aave V3 Ethereum market and reserve configuration from
 * AaveKit. This is provider-indexed data, not an RPC block-pinned oracle quote.
 */
export async function fetchAaveMarketSnapshot(): Promise<AaveMarketSnapshot> {
  const query = `query VaultHunterEthereumMarket {
    market(request: {
      address: "${AAVE_V3_ETHEREUM_MARKET}"
      chainId: 1
    }) {
      name
      address
      chain { name chainId }
      totalMarketSize
      totalAvailableLiquidity
      reserves {
        underlyingToken { address name symbol decimals }
        size { usd amount { value } }
        usdExchangeRate
        usdOracleAddress
        isFrozen
        isPaused
        flashLoanEnabled
        supplyInfo {
          liquidationBonus { raw decimals value formatted }
          liquidationThreshold { raw decimals value formatted }
          canBeCollateral
        }
        borrowInfo {
          availableLiquidity { usd amount { value } }
          borrowingState
        }
      }
    }
  }`;

  const response = await fetch(AAVEKIT_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("AaveKit returned HTTP " + response.status);

  const payload = await response.json() as GraphqlPayload;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message ?? "GraphQL error").join("; "));
  }
  if (!payload.data?.market) throw new Error("AaveKit returned no Ethereum V3 market");
  const market = payload.data.market;
  return {
    market: {
      name: market.name,
      address: market.address,
      chain: market.chain,
      totalMarketSize: market.totalMarketSize,
      totalAvailableLiquidity: market.totalAvailableLiquidity
    },
    reserves: market.reserves ?? [],
    source: "aavekit-graphql",
    freshness: "provider-indexed-not-pinned",
    retrievedAt: new Date().toISOString(),
    warning: "Market data may be cached and is not pinned to the RPC scan block. Re-read reserve configuration and prices directly from Ethereum at one pinned block before any liquidation simulation."
  };
}
