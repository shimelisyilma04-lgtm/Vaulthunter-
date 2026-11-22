// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MorphoAaveFlashloanForkExecutor, IERC20Minimal, IAaveV3PoolMinimal, IMorphoBlueMinimal, IUniswapV3RouterMinimal} from "../contracts/MorphoAaveFlashloanForkExecutor.sol";

contract MockToken is IERC20Minimal {
    mapping(address => uint256) public override balanceOf;
    function approve(address, uint256) external pure override returns (bool) { return true; }
}

contract MockAavePool is IAaveV3PoolMinimal {
    uint256 public premium = 1;
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external override {
        (bool ok, bytes memory result) = receiver.call(
            abi.encodeWithSignature("executeOperation(address,uint256,uint256,address,bytes)", asset, amount, premium, msg.sender, params)
        );
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}

contract MockMorpho is IMorphoBlueMinimal {
    function liquidate(MarketParams calldata, address, uint256 seizedAssets, uint256, bytes calldata)
        external pure override returns (uint256, uint256, uint256, uint256)
    {
        return (seizedAssets == 0 ? 50 : seizedAssets, 100, 0, 0);
    }
}

contract MockV3Router is IUniswapV3RouterMinimal {
    uint256 public output;
    constructor(uint256 output_) { output = output_; }
    function exactInput(ExactInputParams calldata) external payable override returns (uint256) { return output; }
}

contract MorphoAaveFlashloanForkExecutorTest {
    function _deploy(uint256 routerOutput) internal returns (MorphoAaveFlashloanForkExecutor executor) {
        MockAavePool aave = new MockAavePool();
        MockMorpho morpho = new MockMorpho();
        MockV3Router router = new MockV3Router(routerOutput);
        executor = new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));
    }

    function _plan() internal view returns (MorphoAaveFlashloanForkExecutor.LiquidationPlan memory plan) {
        address loan = address(0x1001);
        address collateral = address(0x1002);
        plan.marketParams = IMorphoBlueMinimal.MarketParams({
            loanToken: loan,
            collateralToken: collateral,
            oracle: address(0x1003),
            irm: address(0x1004),
            lltv: 8e17
        });
        plan.borrower = address(0x2001);
        plan.seizedAssets = 0;
        plan.repaidShares = 25;
        plan.swapPath = abi.encodePacked(collateral, uint24(3000), loan);
        plan.minProfit = 5;
        plan.deadline = block.timestamp + 60;
    }

    function testCompleteCallbackPathSucceedsWhenMinimumProfitIsCovered() external {
        MorphoAaveFlashloanForkExecutor executor = _deploy(106);
        executor.simulate(_plan(), 100);
    }

    function testRevertsWhenSwapOutputCannotRepayFlashLoanAndMinimumProfit() external {
        MorphoAaveFlashloanForkExecutor executor = _deploy(105);
        (bool ok,) = address(executor).call(
            abi.encodeCall(executor.simulate, (_plan(), 100))
        );
        require(!ok, "expected unprofitable simulation to revert");
    }

    function testRejectsWrongPathEndpoints() external {
        MorphoAaveFlashloanForkExecutor executor = _deploy(106);
        MorphoAaveFlashloanForkExecutor.LiquidationPlan memory plan = _plan();
        plan.swapPath = abi.encodePacked(address(0x9999), uint24(3000), plan.marketParams.loanToken);
        (bool ok,) = address(executor).call(abi.encodeCall(executor.simulate, (plan, 100)));
        require(!ok, "expected path mismatch to revert");
    }
}
