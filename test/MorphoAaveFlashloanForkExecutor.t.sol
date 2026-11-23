// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    MorphoAaveFlashloanForkExecutor,
    IERC20Minimal,
    IAaveV3PoolMinimal,
    IMorphoBlueMinimal,
    IUniswapV3RouterMinimal
} from "../contracts/MorphoAaveFlashloanForkExecutor.sol";

interface IMintableToken is IERC20Minimal {
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockToken is IMintableToken {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external override { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MOCK_BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MOCK_ALLOWANCE");
        require(balanceOf[from] >= amount, "MOCK_BALANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockAavePool is IAaveV3PoolMinimal {
    IMintableToken public immutable token;
    uint256 public constant PREMIUM = 1;
    constructor(IMintableToken token_) { token = token_; }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external override {
        require(asset == address(token), "MOCK_ASSET");
        require(token.transfer(receiver, amount), "MOCK_FLASH_TRANSFER");
        (bool ok, bytes memory result) = receiver.call(
            abi.encodeWithSignature(
                "executeOperation(address,uint256,uint256,address,bytes)",
                asset, amount, PREMIUM, msg.sender, params
            )
        );
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        require(token.transferFrom(receiver, address(this), amount + PREMIUM), "MOCK_FLASH_REPAY");
    }
}

contract MockMorpho is IMorphoBlueMinimal {
    IMintableToken public immutable loan;
    IMintableToken public immutable collateral;
    constructor(IMintableToken loan_, IMintableToken collateral_) {
        loan = loan_;
        collateral = collateral_;
    }
    function liquidate(MarketParams calldata, address, uint256, uint256, bytes calldata)
        external override returns (uint256 seizedAssets, uint256 repaidAssets)
    {
        repaidAssets = 100;
        seizedAssets = 50;
        require(loan.transferFrom(msg.sender, address(this), repaidAssets), "MOCK_MORPHO_REPAY");
        require(collateral.transfer(msg.sender, seizedAssets), "MOCK_COLLATERAL_TRANSFER");
    }
}

contract MockV3Router is IUniswapV3RouterMinimal {
    IMintableToken public immutable loan;
    IMintableToken public immutable collateral;
    uint256 public immutable output;
    constructor(IMintableToken loan_, IMintableToken collateral_, uint256 output_) {
        loan = loan_;
        collateral = collateral_;
        output = output_;
    }
    function exactInput(ExactInputParams calldata params) external payable override returns (uint256) {
        require(params.amountIn == 50, "MOCK_SWAP_AMOUNT");
        require(collateral.transferFrom(msg.sender, address(this), params.amountIn), "MOCK_SWAP_INPUT");
        require(output >= params.amountOutMinimum, "MOCK_MIN_OUTPUT");
        require(loan.transfer(params.recipient, output), "MOCK_SWAP_OUTPUT");
        return output;
    }
}

contract MorphoAaveFlashloanForkExecutorTest {
    function _deploy(uint256 routerOutput) internal returns (MorphoAaveFlashloanForkExecutor executor) {
        MockToken loan = new MockToken();
        MockToken collateral = new MockToken();
        MockAavePool aave = new MockAavePool(loan);
        MockMorpho morpho = new MockMorpho(loan, collateral);
        MockV3Router router = new MockV3Router(loan, collateral, routerOutput);
        loan.mint(address(aave), 10_000);
        loan.mint(address(router), 10_000);
        collateral.mint(address(morpho), 1_000);
        executor = new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));
    }

    function _plan() internal view returns (MorphoAaveFlashloanForkExecutor.LiquidationPlan memory plan) {
        address loan = address(0x1001);
        address collateral = address(0x1002);
        plan.marketParams = IMorphoBlueMinimal.MarketParams({
            loanToken: loan, collateralToken: collateral,
            oracle: address(0x1003), irm: address(0x1004), lltv: 8e17
        });
        plan.borrower = address(0x2001);
        plan.seizedAssets = 0;
        plan.repaidShares = 25;
        plan.swapPath = abi.encodePacked(collateral, uint24(3000), loan);
        plan.minProfit = 5;
        plan.deadline = block.timestamp + 60;
    }

    function testCompleteCallbackPathReturnsRealizedProfitAfterRepayment() external {
        MockToken loan = new MockToken();
        MockToken collateral = new MockToken();
        MockAavePool aave = new MockAavePool(loan);
        MockMorpho morpho = new MockMorpho(loan, collateral);
        MockV3Router router = new MockV3Router(loan, collateral, 106);
        loan.mint(address(aave), 10_000);
        loan.mint(address(router), 10_000);
        collateral.mint(address(morpho), 1_000);
        MorphoAaveFlashloanForkExecutor executor =
            new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));
        uint256 profit = executor.simulate(_planFor(address(loan), address(collateral)), 100);
        require(profit == 5, "WRONG_REALIZED_PROFIT");
        require(loan.balanceOf(address(executor)) == 5, "PROFIT_NOT_RETAINED");
    }

    function testDetailedReportIncludesMorphoSwapAndAaveSettlementAmounts() external {
        MockToken loan = new MockToken();
        MockToken collateral = new MockToken();
        MockAavePool aave = new MockAavePool(loan);
        MockMorpho morpho = new MockMorpho(loan, collateral);
        MockV3Router router = new MockV3Router(loan, collateral, 106);
        loan.mint(address(aave), 10_000);
        loan.mint(address(router), 10_000);
        collateral.mint(address(morpho), 1_000);
        MorphoAaveFlashloanForkExecutor executor =
            new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));

        MorphoAaveFlashloanForkExecutor.SimulationReport memory report =
            executor.simulateDetailed(_planFor(address(loan), address(collateral)), 100);

        require(report.repaidAssets == 100, "WRONG_MORPHO_REPAYMENT");
        require(report.seizedAssets == 50, "WRONG_COLLATERAL_SEIZED");
        require(report.swapOutput == 106, "WRONG_SWAP_OUTPUT");
        require(report.flashPremium == 1, "WRONG_AAVE_PREMIUM");
        require(report.realizedProfit == 5, "WRONG_NET_SETTLEMENT_PROFIT");
    }

    function testRevertsWhenSwapCannotRepayFlashLoanAndMinimumProfit() external {
        MockToken loan = new MockToken();
        MockToken collateral = new MockToken();
        MockAavePool aave = new MockAavePool(loan);
        MockMorpho morpho = new MockMorpho(loan, collateral);
        MockV3Router router = new MockV3Router(loan, collateral, 105);
        loan.mint(address(aave), 10_000);
        loan.mint(address(router), 10_000);
        collateral.mint(address(morpho), 1_000);
        MorphoAaveFlashloanForkExecutor executor =
            new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));
        (bool ok,) = address(executor).call(
            abi.encodeCall(executor.simulate, (_planFor(address(loan), address(collateral)), 100))
        );
        require(!ok, "EXPECTED_UNPROFITABLE_SIMULATION_TO_REVERT");
    }

    function testRejectsWrongPathEndpoints() external {
        MockToken loan = new MockToken();
        MockToken collateral = new MockToken();
        MockAavePool aave = new MockAavePool(loan);
        MockMorpho morpho = new MockMorpho(loan, collateral);
        MockV3Router router = new MockV3Router(loan, collateral, 106);
        loan.mint(address(aave), 10_000);
        loan.mint(address(router), 10_000);
        collateral.mint(address(morpho), 1_000);
        MorphoAaveFlashloanForkExecutor executor =
            new MorphoAaveFlashloanForkExecutor(address(aave), address(morpho), address(router));
        MorphoAaveFlashloanForkExecutor.LiquidationPlan memory plan =
            _planFor(address(loan), address(collateral));
        plan.swapPath = abi.encodePacked(address(0x9999), uint24(3000), address(loan));
        (bool ok,) = address(executor).call(abi.encodeCall(executor.simulate, (plan, 100)));
        require(!ok, "EXPECTED_PATH_MISMATCH_TO_REVERT");
    }

    function _planFor(address loan, address collateral)
        internal view returns (MorphoAaveFlashloanForkExecutor.LiquidationPlan memory plan)
    {
        plan.marketParams = IMorphoBlueMinimal.MarketParams({
            loanToken: loan, collateralToken: collateral,
            oracle: address(0x1003), irm: address(0x1004), lltv: 8e17
        });
        plan.borrower = address(0x2001);
        plan.seizedAssets = 0;
        plan.repaidShares = 25;
        plan.swapPath = abi.encodePacked(collateral, uint24(3000), loan);
        plan.minProfit = 5;
        plan.deadline = block.timestamp + 60;
    }
}
