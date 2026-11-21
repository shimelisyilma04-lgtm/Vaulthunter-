// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TEST-ONLY architecture harness. Never deploy this file or treat it as an executor.
interface IERC20Harness {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}
interface IAaveSimpleReceiverHarness {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}
interface IMorphoLiquidateCallbackHarness {
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external;
}
interface IMorphoFlashLoanCallbackHarness {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
interface IAavePoolHarness {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}
interface IMorphoHarness {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function liquidate(address loanToken, address collateralToken, address borrower, uint256 seizedAssets, uint256 repaidAssets, bytes calldata data) external;
}
interface ISwapHarness {
    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient) external returns (uint256);
}

contract MockERC20Harness is IERC20Harness {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        require(balanceOf[from] >= amount, "BALANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract MockSwapRouterHarness is ISwapHarness {
    uint256 public configuredOutput;
    function setOutput(uint256 amount) external { configuredOutput = amount; }
    function swapExactInput(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient) external returns (uint256) {
        require(configuredOutput >= amountOutMin, "MIN_OUT");
        require(IERC20Harness(tokenIn).transferFrom(msg.sender, address(this), amountIn), "INPUT_TRANSFER");
        require(IERC20Harness(tokenOut).transfer(recipient, configuredOutput), "OUTPUT_TRANSFER");
        return configuredOutput;
    }
}

contract MockAavePoolHarness is IAavePoolHarness {
    IERC20Harness public immutable debtToken;
    IERC20Harness public immutable collateralToken;
    uint256 public premiumBps;
    uint256 public seizedCollateral;
    bool public attemptReentry;
    bool public reentryBlocked;
    constructor(address debt, address collateral, uint256 premium) {
        debtToken = IERC20Harness(debt); collateralToken = IERC20Harness(collateral); premiumBps = premium;
    }
    function setPremium(uint256 value) external { premiumBps = value; }
    function setSeizedCollateral(uint256 value) external { seizedCollateral = value; }
    function setAttemptReentry(bool value) external { attemptReentry = value; reentryBlocked = false; }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16) external override {
        require(asset == address(debtToken), "ASSET");
        require(debtToken.transfer(receiver, amount), "LOAN_TRANSFER");
        uint256 premium = amount * premiumBps / 10_000;
        require(IAaveSimpleReceiverHarness(receiver).executeOperation(asset, amount, premium, msg.sender, params), "CALLBACK");
        require(debtToken.transferFrom(receiver, address(this), amount + premium), "REPAYMENT");
    }
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool) external override {
        require(collateralAsset == address(collateralToken) && debtAsset == address(debtToken), "PAIR");
        require(user != address(0), "BORROWER");
        require(debtToken.transferFrom(msg.sender, address(this), debtToCover), "LIQUIDATION_REPAY");
        if (attemptReentry) {
            try IAaveSimpleReceiverHarness(msg.sender).executeOperation(address(debtToken), debtToCover, 0, msg.sender, "") returns (bool) {
                reentryBlocked = false;
            } catch { reentryBlocked = true; }
        }
        require(collateralToken.transfer(msg.sender, seizedCollateral), "COLLATERAL_TRANSFER");
    }
    function invokeCallback(address receiver, address asset, uint256 amount, uint256 premium, address initiator) external {
        IAaveSimpleReceiverHarness(receiver).executeOperation(asset, amount, premium, initiator, "");
    }
}

contract MockMorphoHarness is IMorphoHarness {
    function flashLoan(address token, uint256 assets, bytes calldata data) external override {
        require(IERC20Harness(token).transfer(msg.sender, assets), "FLASH_TRANSFER");
        IMorphoFlashLoanCallbackHarness(msg.sender).onMorphoFlashLoan(assets, data);
        require(IERC20Harness(token).transferFrom(msg.sender, address(this), assets), "FLASH_REPAY");
    }
    function liquidate(address loanToken, address collateralToken, address borrower, uint256 seizedAssets, uint256 repaidAssets, bytes calldata data) external override {
        require(borrower != address(0), "BORROWER");
        require(IERC20Harness(collateralToken).transfer(msg.sender, seizedAssets), "SEIZE_TRANSFER");
        IMorphoLiquidateCallbackHarness(msg.sender).onMorphoLiquidate(repaidAssets, data);
        require(IERC20Harness(loanToken).transferFrom(msg.sender, address(this), repaidAssets), "LIQUIDATION_REPAY");
    }
}

/**
 * Test-only callback state machine. It demonstrates the required invariants;
 * it is deliberately outside src/, has no owner key, no deploy script, and
 * must not be reused as production execution code.
 */
contract IsolatedExecutorHarness is IAaveSimpleReceiverHarness, IMorphoLiquidateCallbackHarness, IMorphoFlashLoanCallbackHarness {
    address public immutable owner;
    IAavePoolHarness public immutable aavePool;
    IMorphoHarness public immutable morpho;
    ISwapHarness public immutable router;

    struct Plan {
        address debtToken;
        address collateralToken;
        address borrower;
        uint256 amount;
        uint256 seized;
        uint256 repaidAssets;
        uint256 minOut;
        uint256 minProfit;
        uint256 maxPremium;
    }
    Plan private aavePlan;
    Plan private morphoPlan;
    uint256 private aaveBaseline;
    uint256 private morphoBaseline;
    bool private aaveActive;
    bool private aaveCallbackEntered;
    bool private morphoActive;
    bool private morphoOuterEntered;
    bool private morphoLiquidationEntered;

    constructor(address pool, address morphoAddress, address swapRouter) {
        owner = msg.sender;
        aavePool = IAavePoolHarness(pool);
        morpho = IMorphoHarness(morphoAddress);
        router = ISwapHarness(swapRouter);
    }
    modifier onlyOwner() { require(msg.sender == owner, "OWNER"); _; }

    function startAave(Plan calldata plan) external onlyOwner {
        require(!aaveActive && plan.amount > 0 && plan.seized > 0, "PLAN");
        require(plan.debtToken != address(0) && plan.collateralToken != address(0) && plan.debtToken != plan.collateralToken, "TOKENS");
        aavePlan = plan;
        aaveBaseline = IERC20Harness(plan.debtToken).balanceOf(address(this));
        aaveActive = true;
        aavePool.flashLoanSimple(address(this), plan.debtToken, plan.amount, "", 0);
        require(!aaveActive, "CALLBACK_NOT_COMPLETED");
        delete aavePlan;
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata) external override returns (bool) {
        require(msg.sender == address(aavePool), "AAVE_CALLER");
        require(initiator == address(this), "AAVE_INITIATOR");
        require(aaveActive && !aaveCallbackEntered, "AAVE_STATE");
        Plan memory p = aavePlan;
        require(asset == p.debtToken && amount == p.amount, "AAVE_LOAN_MISMATCH");
        require(premium <= p.maxPremium, "AAVE_PREMIUM");
        aaveCallbackEntered = true;

        aavePool.liquidationCall(p.collateralToken, p.debtToken, p.borrower, amount, false);
        IERC20Harness(p.collateralToken).approve(address(router), p.seized);
        uint256 beforeOut = IERC20Harness(p.debtToken).balanceOf(address(this));
        router.swapExactInput(p.collateralToken, p.debtToken, p.seized, p.minOut, address(this));
        IERC20Harness(p.collateralToken).approve(address(router), 0);
        uint256 measuredOut = IERC20Harness(p.debtToken).balanceOf(address(this)) - beforeOut;
        require(measuredOut >= p.minOut, "MEASURED_MIN_OUT");
        require(IERC20Harness(p.debtToken).balanceOf(address(this)) >= aaveBaseline + amount + premium + p.minProfit, "AAVE_UNPROFITABLE");

        IERC20Harness(p.debtToken).approve(address(aavePool), amount + premium);
        aaveCallbackEntered = false;
        aaveActive = false;
        return true;
    }

    function startMorpho(Plan calldata plan) external onlyOwner {
        require(!morphoActive && plan.amount > 0 && plan.seized > 0 && plan.repaidAssets > 0, "PLAN");
        require(plan.debtToken != address(0) && plan.collateralToken != address(0) && plan.debtToken != plan.collateralToken, "TOKENS");
        morphoPlan = plan;
        morphoBaseline = IERC20Harness(plan.debtToken).balanceOf(address(this));
        morphoActive = true;
        morpho.flashLoan(plan.debtToken, plan.amount, "");
        require(!morphoActive, "CALLBACK_NOT_COMPLETED");
        delete morphoPlan;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata) external override {
        require(msg.sender == address(morpho), "MORPHO_CALLER");
        require(morphoActive && !morphoOuterEntered, "MORPHO_STATE");
        Plan memory p = morphoPlan;
        require(assets == p.amount, "MORPHO_FLASH_AMOUNT");
        morphoOuterEntered = true;
        morpho.liquidate(p.debtToken, p.collateralToken, p.borrower, p.seized, p.repaidAssets, "");
        morphoOuterEntered = false;
        require(IERC20Harness(p.debtToken).balanceOf(address(this)) >= morphoBaseline + assets + p.minProfit, "MORPHO_UNPROFITABLE");
        IERC20Harness(p.debtToken).approve(address(morpho), assets);
        morphoActive = false;
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata) external override {
        require(msg.sender == address(morpho), "MORPHO_CALLER");
        require(morphoActive && morphoOuterEntered && !morphoLiquidationEntered, "MORPHO_CALLBACK_STATE");
        Plan memory p = morphoPlan;
        require(repaidAssets == p.repaidAssets, "MORPHO_REPAY_MISMATCH");
        morphoLiquidationEntered = true;
        IERC20Harness(p.collateralToken).approve(address(router), p.seized);
        uint256 beforeOut = IERC20Harness(p.debtToken).balanceOf(address(this));
        router.swapExactInput(p.collateralToken, p.debtToken, p.seized, p.minOut, address(this));
        IERC20Harness(p.collateralToken).approve(address(router), 0);
        uint256 measuredOut = IERC20Harness(p.debtToken).balanceOf(address(this)) - beforeOut;
        require(measuredOut >= p.minOut, "MEASURED_MIN_OUT");
        require(IERC20Harness(p.debtToken).balanceOf(address(this)) >= morphoBaseline + p.amount + repaidAssets + p.minProfit, "MORPHO_LIQUIDATION_UNPROFITABLE");
        IERC20Harness(p.debtToken).approve(address(morpho), repaidAssets);
        morphoLiquidationEntered = false;
    }
}

contract ExecutorArchitectureTest {
    MockERC20Harness private debt;
    MockERC20Harness private collateral;
    MockAavePoolHarness private aave;
    MockMorphoHarness private morpho;
    MockSwapRouterHarness private router;
    IsolatedExecutorHarness private executor;
    address private constant BORROWER = address(0xB0B);

    function setUp() public {
        debt = new MockERC20Harness();
        collateral = new MockERC20Harness();
        aave = new MockAavePoolHarness(address(debt), address(collateral), 100);
        morpho = new MockMorphoHarness();
        router = new MockSwapRouterHarness();
        executor = new IsolatedExecutorHarness(address(aave), address(morpho), address(router));
        debt.mint(address(aave), 10_000);
        debt.mint(address(morpho), 10_000);
        debt.mint(address(router), 10_000);
        collateral.mint(address(aave), 10_000);
        collateral.mint(address(morpho), 10_000);
        router.setOutput(120);
        aave.setSeizedCollateral(50);
    }

    function _plan(uint256 minOut, uint256 minProfit, uint256 maxPremium) private view returns (IsolatedExecutorHarness.Plan memory) {
        return IsolatedExecutorHarness.Plan({
            debtToken: address(debt), collateralToken: address(collateral), borrower: BORROWER,
            amount: 100, seized: 50, repaidAssets: 100, minOut: minOut,
            minProfit: minProfit, maxPremium: maxPremium
        });
    }

    function testAaveCallbackRepaysPremiumAndPreservesMinimumProfit() public {
        executor.startAave(_plan(110, 10, 2));
        require(debt.balanceOf(address(executor)) >= 19, "AAVE_PROFIT_NOT_RETAINED");
    }

    function testAaveRejectsWrongInitiator() public {
        bool reverted;
        try aave.invokeCallback(address(executor), address(debt), 100, 1, address(0xBAD)) {} catch { reverted = true; }
        require(reverted, "WRONG_INITIATOR_ACCEPTED");
    }

    function testAaveRejectsExcessivePremium() public {
        aave.setPremium(500);
        bool reverted;
        try executor.startAave(_plan(100, 1, 2)) {} catch { reverted = true; }
        require(reverted, "EXCESS_PREMIUM_ACCEPTED");
        require(debt.balanceOf(address(aave)) == 10_000, "AAVE_STATE_NOT_ROLLED_BACK");
    }

    function testAaveReentrancyAttemptIsBlocked() public {
        aave.setAttemptReentry(true);
        executor.startAave(_plan(110, 10, 2));
        require(aave.reentryBlocked(), "REENTRY_NOT_BLOCKED");
    }

    function testAaveAtomicRollbackWhenSwapMinimumFails() public {
        router.setOutput(100);
        uint256 poolDebtBefore = debt.balanceOf(address(aave));
        uint256 poolCollateralBefore = collateral.balanceOf(address(aave));
        bool reverted;
        try executor.startAave(_plan(110, 10, 2)) {} catch { reverted = true; }
        require(reverted, "BAD_SWAP_ACCEPTED");
        require(debt.balanceOf(address(aave)) == poolDebtBefore, "DEBT_NOT_ROLLED_BACK");
        require(collateral.balanceOf(address(aave)) == poolCollateralBefore, "COLLATERAL_NOT_ROLLED_BACK");
        require(debt.balanceOf(address(executor)) == 0, "EXECUTOR_BALANCE_CHANGED");
    }

    function testAaveRejectsSwapThatCannotCoverRepaymentAndProfit() public {
        router.setOutput(105);
        bool reverted;
        try executor.startAave(_plan(100, 10, 2)) {} catch { reverted = true; }
        require(reverted, "UNPROFITABLE_AAVE_PLAN_ACCEPTED");
    }

    function testMorphoNestedLiquidationCallbackAndFlashLoanRepayment() public {
        executor.startMorpho(_plan(110, 10, 0));
        require(debt.balanceOf(address(executor)) >= 20, "MORPHO_PROFIT_NOT_RETAINED");
    }

    function testMorphoRejectsUnauthorizedLiquidationCallback() public {
        bool reverted;
        try executor.onMorphoLiquidate(100, "") {} catch { reverted = true; }
        require(reverted, "UNAUTHORIZED_MORPHO_CALLBACK_ACCEPTED");
    }

    function testMorphoAtomicRollbackWhenSwapMinimumFails() public {
        router.setOutput(100);
        uint256 morphoDebtBefore = debt.balanceOf(address(morpho));
        uint256 morphoCollateralBefore = collateral.balanceOf(address(morpho));
        bool reverted;
        try executor.startMorpho(_plan(110, 10, 0)) {} catch { reverted = true; }
        require(reverted, "BAD_MORPHO_SWAP_ACCEPTED");
        require(debt.balanceOf(address(morpho)) == morphoDebtBefore, "MORPHO_DEBT_NOT_ROLLED_BACK");
        require(collateral.balanceOf(address(morpho)) == morphoCollateralBefore, "MORPHO_COLLATERAL_NOT_ROLLED_BACK");
        require(debt.balanceOf(address(executor)) == 0, "MORPHO_EXECUTOR_BALANCE_CHANGED");
    }
}
