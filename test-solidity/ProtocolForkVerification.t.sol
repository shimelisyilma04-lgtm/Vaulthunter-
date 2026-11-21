// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Fork-only differential checks against deployed protocol contracts.
// These tests mutate only the local Foundry fork. They never broadcast.
interface VmFork {
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function createSelectFork(string calldata url) external returns (uint256);
    function warp(uint256 timestamp) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function skip(bool skipTest) external;
}

interface IAaveAddressesProviderFork {
    function getPool() external view returns (address);
}

interface IAavePoolFork {
    function getRevision() external view returns (uint256);
    function getReservesList() external view returns (address[] memory);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IMorphoBlueFork {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }
    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function market(bytes32 id) external view returns (Market memory);
    function accrueInterest(MarketParams calldata marketParams) external;
}

interface IMorphoIrmFork {
    function borrowRateView(
        IMorphoBlueFork.MarketParams calldata marketParams,
        IMorphoBlueFork.Market calldata market
    ) external view returns (uint256);
}

contract ProtocolForkVerificationTest {
    VmFork private constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant WAD = 1e18;
    bytes32 private constant IMPLEMENTATION_SLOT =
        bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    address private constant BASE_AAVE_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address private constant BASE_AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address private constant ARBITRUM_AAVE_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address private constant ARBITRUM_AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address private constant BASE_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant ARBITRUM_MORPHO = 0x6c247b1F6182318877311737BaC0844bAa518F5e;

    // Public Morpho API documentation's Base cbBTC/USDC market example.
    bytes32 private constant BASE_MORPHO_MARKET =
        0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836;

    function testBaseAaveAndMorphoDeploymentIdentity() external {
        string memory rpc = vm.envOr("BASE_RPC_URL", "https://mainnet.base.org");
        vm.createSelectFork(rpc);
        require(block.chainid == 8453, "BASE_CHAIN_ID");
        address pool = IAaveAddressesProviderFork(BASE_AAVE_PROVIDER).getPool();
        require(pool == BASE_AAVE_POOL, "BASE_AAVE_POOL_MISMATCH");
        require(pool.code.length > 0, "BASE_AAVE_POOL_NO_CODE");
        address implementation = address(uint160(uint256(vm.load(pool, IMPLEMENTATION_SLOT))));
        require(implementation != address(0) && implementation.code.length > 0, "BASE_AAVE_IMPLEMENTATION_MISSING");
        require(IAavePoolFork(pool).getRevision() > 0, "BASE_AAVE_REVISION_ZERO");
        require(IAavePoolFork(pool).getReservesList().length > 0, "BASE_AAVE_NO_RESERVES");
        require(BASE_MORPHO.code.length > 0, "BASE_MORPHO_NO_CODE");
    }

    function testArbitrumAaveAndMorphoDeploymentIdentity() external {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc");
        vm.createSelectFork(rpc);
        require(block.chainid == 42161, "ARBITRUM_CHAIN_ID");
        address pool = IAaveAddressesProviderFork(ARBITRUM_AAVE_PROVIDER).getPool();
        require(pool == ARBITRUM_AAVE_POOL, "ARBITRUM_AAVE_POOL_MISMATCH");
        require(pool.code.length > 0, "ARBITRUM_AAVE_POOL_NO_CODE");
        address implementation = address(uint160(uint256(vm.load(pool, IMPLEMENTATION_SLOT))));
        require(implementation != address(0) && implementation.code.length > 0, "ARBITRUM_AAVE_IMPLEMENTATION_MISSING");
        require(IAavePoolFork(pool).getRevision() > 0, "ARBITRUM_AAVE_REVISION_ZERO");
        require(IAavePoolFork(pool).getReservesList().length > 0, "ARBITRUM_AAVE_NO_RESERVES");
        require(ARBITRUM_MORPHO.code.length > 0, "ARBITRUM_MORPHO_NO_CODE");
    }

    function testBaseMorphoAccrualMatchesDeployedCore() external {
        string memory rpc = vm.envOr("BASE_RPC_URL", "https://mainnet.base.org");
        vm.createSelectFork(rpc);
        require(block.chainid == 8453, "BASE_CHAIN_ID");
        _assertMorphoAccrual(BASE_MORPHO, BASE_MORPHO_MARKET);
    }

    function testArbitrumMorphoAccrualMatchesDeployedCoreWhenMarketConfigured() external {
        string memory marketIdHex = vm.envOr("MORPHO_ARBITRUM_MARKET_ID", "");
        if (bytes(marketIdHex).length == 0) {
            vm.skip(true);
            return;
        }
        require(bytes(marketIdHex).length == 66 && bytes(marketIdHex)[0] == "0" && bytes(marketIdHex)[1] == "x", "ARBITRUM_MARKET_ID_FORMAT");
        bytes32 marketId = _parseBytes32(marketIdHex);
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc");
        vm.createSelectFork(rpc);
        require(block.chainid == 42161, "ARBITRUM_CHAIN_ID");
        _assertMorphoAccrual(ARBITRUM_MORPHO, marketId);
    }

    function _assertMorphoAccrual(address morphoAddress, bytes32 marketId) private {
        IMorphoBlueFork morpho = IMorphoBlueFork(morphoAddress);
        IMorphoBlueFork.MarketParams memory params = morpho.idToMarketParams(marketId);
        require(params.loanToken != address(0) && params.irm.code.length > 0, "MORPHO_MARKET_OR_IRM_MISSING");
        IMorphoBlueFork.Market memory beforeMarket = morpho.market(marketId);
        require(beforeMarket.lastUpdate > 0, "MORPHO_MARKET_NOT_INITIALIZED");

        // Advance only the local fork. Morpho core accrues using the current
        // IRM rate and its own fixed-point Taylor math.
        uint256 targetTimestamp = block.timestamp + 3_600;
        vm.warp(targetTimestamp);
        uint256 rate = IMorphoIrmFork(params.irm).borrowRateView(params, beforeMarket);
        uint256 elapsed = targetTimestamp - uint256(beforeMarket.lastUpdate);
        uint256 x = rate * elapsed;
        uint256 secondTerm = (x * x) / (2 * WAD);
        uint256 thirdTerm = (secondTerm * x) / (3 * WAD);
        uint256 compounded = x + secondTerm + thirdTerm;
        uint256 interest = (uint256(beforeMarket.totalBorrowAssets) * compounded) / WAD;
        uint256 expectedTotalBorrowAssets = uint256(beforeMarket.totalBorrowAssets) + interest;

        morpho.accrueInterest(params);
        IMorphoBlueFork.Market memory afterMarket = morpho.market(marketId);
        require(uint256(afterMarket.totalBorrowAssets) == expectedTotalBorrowAssets, "MORPHO_ACCRUAL_DIFFERS_FROM_CORE");
        require(uint256(afterMarket.lastUpdate) == targetTimestamp, "MORPHO_ACCRUAL_TIMESTAMP_MISMATCH");
    }

    function _parseBytes32(string memory value) private pure returns (bytes32 result) {
        bytes memory data = bytes(value);
        require(data.length == 66 && data[0] == "0" && data[1] == "x", "INVALID_BYTES32");
        for (uint256 i = 0; i < 32; i++) {
            result |= bytes32(uint256(_nibble(uint8(data[2 + i * 2])) << 4 | _nibble(uint8(data[3 + i * 2]))) << (248 - i * 8));
        }
    }

    function _nibble(uint8 char) private pure returns (uint8) {
        if (char >= 48 && char <= 57) return char - 48;
        if (char >= 65 && char <= 70) return char - 55;
        if (char >= 97 && char <= 102) return char - 87;
        revert("INVALID_HEX");
    }
}
