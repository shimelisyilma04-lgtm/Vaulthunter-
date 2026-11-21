import { Contract, JsonRpcProvider, getAddress, keccak256 } from "ethers";
import { AAVE_V3_MARKETS, type AaveL2Network } from "../aave/l2-readonly.js";
import { MORPHO_BLUE_ADDRESSES, type MorphoNetwork } from "../morpho/blue.js";

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROVIDER_ABI = ["function getPool() view returns (address)"] as const;
const POOL_ABI = [
  "function POOL_REVISION() view returns (uint256)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD() view returns (uint256)",
  "function MIN_LEFTOVER_BASE() view returns (uint256)"
] as const;
const BITMAP_EMODE_ABI = [
  "function getEModeCategoryData(uint8) view returns (uint16,uint16,uint16,uint128,uint128,string)"
] as const;
const LEGACY_EMODE_ABI = [
  "function getEModeCategoryData(uint8) view returns (uint16,uint16,uint16,address,string)"
] as const;

async function optionalUint(contract: Contract, method: string, blockTag: number): Promise<string | null> {
  try { return String(await contract.getFunction(method).staticCall({ blockTag })); }
  catch { return null; }
}
async function verifyAave(network: AaveL2Network, rpcUrl: string) {
  const deployment = AAVE_V3_MARKETS[network];
  const provider = new JsonRpcProvider(rpcUrl, deployment.chainId, { staticNetwork: true });
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(deployment.chainId)) throw new Error(`${network}: wrong chain ID ${chain.chainId}`);
    const blockNumber = await provider.getBlockNumber();
    const addressesProvider = new Contract(deployment.addressesProvider, PROVIDER_ABI, provider);
    const poolAddress = getAddress(String(await addressesProvider.getFunction("getPool").staticCall({ blockTag: blockNumber })));
    if (poolAddress !== getAddress(deployment.expectedPool)) {
      throw new Error(`${network}: PoolAddressesProvider returned ${poolAddress}, expected official Pool proxy ${deployment.expectedPool}`);
    }
    const [proxyCode, implementationSlot] = await Promise.all([
      provider.getCode(poolAddress, blockNumber),
      provider.getStorage(poolAddress, EIP1967_IMPLEMENTATION_SLOT, blockNumber)
    ]);
    if (proxyCode === "0x") throw new Error(`${network}: Pool proxy has no runtime code`);
    const implementation = getAddress("0x" + implementationSlot.slice(-40));
    if (implementation === "0x0000000000000000000000000000000000000000") {
      throw new Error(`${network}: EIP-1967 implementation slot is empty; proxy implementation cannot be attested`);
    }
    const implementationCode = await provider.getCode(implementation, blockNumber);
    if (implementationCode === "0x") throw new Error(`${network}: implementation has no runtime code`);
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const [poolRevision, flashLoanPremiumBps, minCloseFactor, minLeftover, bitmapProfile, legacyProfile] = await Promise.all([
      optionalUint(pool, "POOL_REVISION", blockNumber),
      optionalUint(pool, "FLASHLOAN_PREMIUM_TOTAL", blockNumber),
      optionalUint(pool, "MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD", blockNumber),
      optionalUint(pool, "MIN_LEFTOVER_BASE", blockNumber),
      new Contract(poolAddress, BITMAP_EMODE_ABI, provider).getFunction("getEModeCategoryData").staticCall(1, { blockTag: blockNumber }).then(() => true).catch(() => false),
      new Contract(poolAddress, LEGACY_EMODE_ABI, provider).getFunction("getEModeCategoryData").staticCall(1, { blockTag: blockNumber }).then(() => true).catch(() => false)
    ]);
    const eModeAbiProfile = bitmapProfile ? "aave-origin-bitmap" : legacyProfile ? "legacy-price-source" : "unknown";
    if (eModeAbiProfile === "unknown") throw new Error(`${network}: neither known eMode category ABI decoded at pinned block ${blockNumber}`);
    return {
      protocol: "aave-v3",
      network,
      chainId: deployment.chainId,
      blockNumber,
      addressesProvider: deployment.addressesProvider,
      pool: poolAddress,
      proxyRuntimeCodeHash: keccak256(proxyCode),
      implementation,
      implementationRuntimeCodeHash: keccak256(implementationCode),
      poolRevision,
      eModeAbiProfile,
      flashLoanPremiumBps,
      minBaseMaxCloseFactorThreshold: minCloseFactor,
      minLeftoverBase: minLeftover,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT
    };
  } finally {
    await provider.destroy();
  }
}
async function verifyMorpho(network: MorphoNetwork, rpcUrl: string) {
  const chainId = network === "base" ? 8453 : 42161;
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  try {
    const chain = await provider.getNetwork();
    if (chain.chainId !== BigInt(chainId)) throw new Error(`${network}: wrong Morpho chain ID ${chain.chainId}`);
    const blockNumber = await provider.getBlockNumber();
    const address = getAddress(MORPHO_BLUE_ADDRESSES[network]);
    const code = await provider.getCode(address, blockNumber);
    if (code === "0x") throw new Error(`${network}: official Morpho Blue singleton has no runtime code at ${address}`);
    return {
      protocol: "morpho-blue",
      network,
      chainId,
      blockNumber,
      singleton: address,
      runtimeCodeHash: keccak256(code)
    };
  } finally {
    await provider.destroy();
  }
}

const baseRpc = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const arbitrumRpc = process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const results = await Promise.all([
  verifyAave("base", baseRpc),
  verifyAave("arbitrum", arbitrumRpc),
  verifyMorpho("base", baseRpc),
  verifyMorpho("arbitrum", arbitrumRpc)
]);
process.stdout.write(JSON.stringify({
  status: "deployment-identities-verified",
  warning: "This fingerprints deployed addresses and code only. It does not prove source-code equivalence, liquidation math, or transaction success. Compare implementation hashes with verified source builds and run fork differential tests before execution.",
  results
}, null, 2) + "\n");
