export const AAVE_V3_ETHEREUM_ADDRESSES_PROVIDER =
  "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";

export const ADDRESSES_PROVIDER_ABI = [
  "function getPool() view returns (address)"
] as const;

export const AAVE_POOL_ABI = [
  "event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)"
] as const;
