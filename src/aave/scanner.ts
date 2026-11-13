import {
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  type Log
} from "ethers";
import { config } from "../config.js";
import { WAD } from "../domain/liquidation.js";
import {
  AAVE_POOL_ABI,
  AAVE_V3_ETHEREUM_ADDRESSES_PROVIDER,
  ADDRESSES_PROVIDER_ABI
} from "./abi.js";

export interface AaveBorrowerSnapshot {
  protocol: "aave-v3";
  chainId: 1;
  pool: string;
  borrower: string;
  observedBlock: number;
  totalCollateralBase: string;
  totalDebtBase: string;
  healthFactorWad: string;
  liquidationEligible: boolean;
}

export interface AaveScanResult {
  chainId: 1;
  pool: string;
  fromBlock: number;
  toBlock: number;
  borrowersDiscovered: number;
  accountsChecked: number;
  candidates: AaveBorrowerSnapshot[];
  accountReadFailures: number;
}

const poolInterface = new Interface(AAVE_POOL_ABI);
const borrowEvent = poolInterface.getEvent("Borrow");

if (!borrowEvent) {
  throw new Error("Aave Borrow event ABI is unavailable");
}

export function isLiquidationEligible(healthFactorWad: bigint): boolean {
  return healthFactorWad > 0n && healthFactorWad < WAD;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  throw new Error(`Invalid Aave ${label} value`);
}

/**
 * Scans a bounded recent block window for Borrow events, then checks current
 * account data directly against the Pool. This is not a full historical indexer:
 * borrowers with no Borrow event in the selected window are not discovered.
 */
export async function scanAaveBorrowers(
  rpcUrl: string,
  lookbackBlocks = config.AAVE_SCAN_LOOKBACK_BLOCKS
): Promise<AaveScanResult> {
  if (!Number.isInteger(lookbackBlocks) || lookbackBlocks < 1 || lookbackBlocks > 10000) {
    throw new Error("Aave scan lookback must be between 1 and 10000 blocks");
  }

  const provider = new JsonRpcProvider(rpcUrl);
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 1n) {
      throw new Error(`Aave Ethereum adapter requires chain ID 1; received ${network.chainId}`);
    }

    const addressesProvider = new Contract(
      AAVE_V3_ETHEREUM_ADDRESSES_PROVIDER,
      ADDRESSES_PROVIDER_ABI,
      provider
    );
    const poolAddress = getAddress(await addressesProvider.getPool() as string);
    const pool = new Contract(poolAddress, AAVE_POOL_ABI, provider);
    const toBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, toBlock - lookbackBlocks + 1);

    const logs: Log[] = await provider.getLogs({
      address: poolAddress,
      fromBlock,
      toBlock,
      topics: [borrowEvent.topicHash]
    });

    const borrowers = new Set<string>();
    for (const log of logs) {
      try {
        const parsed = poolInterface.parseLog(log);
        const borrower = parsed?.args.onBehalfOf as string | undefined;
        if (borrower) borrowers.add(getAddress(borrower));
      } catch {
        // Ignore malformed/unrecognized logs; never treat them as candidates.
      }
    }

    const candidates: AaveBorrowerSnapshot[] = [];
    let accountReadFailures = 0;
    const addresses = [...borrowers];

    for (let offset = 0; offset < addresses.length; offset += 8) {
      const batch = addresses.slice(offset, offset + 8);
      const results = await Promise.all(batch.map(async (borrower) => {
        try {
          const account = await pool.getUserAccountData(borrower);
          const collateral = asBigInt(account.totalCollateralBase, "collateral");
          const debt = asBigInt(account.totalDebtBase, "debt");
          const healthFactor = asBigInt(account.healthFactor, "health factor");
          if (debt === 0n || !isLiquidationEligible(healthFactor)) return null;
          return {
            protocol: "aave-v3" as const,
            chainId: 1 as const,
            pool: poolAddress,
            borrower,
            observedBlock: toBlock,
            totalCollateralBase: collateral.toString(),
            totalDebtBase: debt.toString(),
            healthFactorWad: healthFactor.toString(),
            liquidationEligible: true
          };
        } catch {
          accountReadFailures += 1;
          return null;
        }
      }));
      candidates.push(...results.filter((item): item is AaveBorrowerSnapshot => item !== null));
    }

    return {
      chainId: 1,
      pool: poolAddress,
      fromBlock,
      toBlock,
      borrowersDiscovered: borrowers.size,
      accountsChecked: borrowers.size - accountReadFailures,
      candidates,
      accountReadFailures
    };
  } finally {
    await provider.destroy();
  }
}
