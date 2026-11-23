// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MorphoAaveFlashloanForkExecutor} from "../contracts/MorphoAaveFlashloanForkExecutor.sol";

interface IAavePoolForkCheck {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

contract RealProtocolForkSmokeTest {
    address private constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    function testRealEthereumProtocolContractsExistOnFork() external view {
        require(block.chainid == 31337, "NOT_ANVIL_FORK");
        require(MORPHO_BLUE.code.length > 0, "MORPHO_CODE_MISSING");
        require(AAVE_V3_POOL.code.length > 0, "AAVE_CODE_MISSING");
        require(UNISWAP_V3_ROUTER.code.length > 0, "UNISWAP_ROUTER_CODE_MISSING");
        uint128 premium = IAavePoolForkCheck(AAVE_V3_POOL).FLASHLOAN_PREMIUM_TOTAL();
        require(premium > 0, "AAVE_PREMIUM_READ_FAILED");
    }

    function testExecutorDeploysWithRealForkProtocolAddresses() external {
        require(block.chainid == 31337, "NOT_ANVIL_FORK");
        MorphoAaveFlashloanForkExecutor executor = new MorphoAaveFlashloanForkExecutor(
            AAVE_V3_POOL, MORPHO_BLUE, UNISWAP_V3_ROUTER
        );
        require(address(executor).code.length > 0, "EXECUTOR_DEPLOY_FAILED");
        require(address(executor.aavePool()) == AAVE_V3_POOL, "AAVE_ADDRESS_MISMATCH");
        require(address(executor.morpho()) == MORPHO_BLUE, "MORPHO_ADDRESS_MISMATCH");
        require(address(executor.swapRouter()) == UNISWAP_V3_ROUTER, "ROUTER_ADDRESS_MISMATCH");
    }
}
