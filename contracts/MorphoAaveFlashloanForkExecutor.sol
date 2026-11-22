// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fork-only research harness. This is NOT audited and MUST NOT be deployed
///         to mainnet. Deploy only to a local Anvil fork configured with chain ID 31337.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IAaveV3PoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IMorphoBlueMinimal {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (
        uint256 seizedAssetsOut,
        uint256 repaidAssetsOut,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );
}

interface IUniswapV3RouterMinimal {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Atomic Aave V3 flashLoanSimple -> Morpho Blue liquidation -> Uniswap V3 exactInput.
///      Chain-id guard intentionally requires Anvil's local chain ID (31337).
///      The swap's minimum output enforces repayment + premium + requested minimum profit.
///      Any revert unwinds the whole flash-loan transaction on the fork.
contract MorphoAaveFlashloanForkExecutor {
    uint256 public constant REQUIRED_FORK_CHAIN_ID = 31337;

    address public immutable owner;
    IAaveV3PoolMinimal public immutable aavePool;
    IMorphoBlueMinimal public immutable morpho;
    IUniswapV3RouterMinimal public immutable swapRouter;

    struct LiquidationPlan {
        IMorphoBlueMinimal.MarketParams marketParams;
        address borrower;
        uint256 seizedAssets;
        uint256 repaidShares;
        bytes swapPath; // Uniswap V3 packed path: token + (fee + token)...
        uint256 minProfit;
        uint256 deadline;
    }

    event ForkLiquidationSimulated(
        address indexed borrower,
        address indexed loanToken,
        address indexed collateralToken,
        uint256 repaidAssets,
        uint256 seizedAssets,
        uint256 swapOutput,
        uint256 flashPremium,
        uint256 minProfit
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyFork() {
        require(block.chainid == REQUIRED_FORK_CHAIN_ID, "ANVIL_FORK_ONLY");
        _;
    }

    constructor(address aavePool_, address morpho_, address swapRouter_) {
        require(block.chainid == REQUIRED_FORK_CHAIN_ID, "DEPLOY_ON_ANVIL_FORK_ONLY");
        require(aavePool_ != address(0) && morpho_ != address(0) && swapRouter_ != address(0), "ZERO_ADDRESS");
        owner = msg.sender;
        aavePool = IAaveV3PoolMinimal(aavePool_);
        morpho = IMorphoBlueMinimal(morpho_);
        swapRouter = IUniswapV3RouterMinimal(swapRouter_);
    }

    function simulate(LiquidationPlan calldata plan, uint256 flashAmount)
        external
        onlyOwner
        onlyFork
    {
        require(flashAmount > 0, "ZERO_FLASH_AMOUNT");
        require(plan.borrower != address(0), "ZERO_BORROWER");
        require(plan.marketParams.loanToken != address(0), "ZERO_LOAN_TOKEN");
        require(plan.marketParams.collateralToken != address(0), "ZERO_COLLATERAL_TOKEN");
        require(plan.marketParams.loanToken != plan.marketParams.collateralToken, "SAME_TOKEN");
        require((plan.seizedAssets == 0) != (plan.repaidShares == 0), "SET_EXACTLY_ONE_LIQUIDATION_AMOUNT");
        require(plan.swapPath.length >= 43 && (plan.swapPath.length - 20) % 23 == 0, "BAD_V3_PATH");
        require(_firstToken(plan.swapPath) == plan.marketParams.collateralToken, "PATH_INPUT_MISMATCH");
        require(_lastToken(plan.swapPath) == plan.marketParams.loanToken, "PATH_OUTPUT_MISMATCH");
        require(plan.deadline >= block.timestamp, "EXPIRED_PLAN");

        bytes memory callbackData = abi.encode(plan);
        aavePool.flashLoanSimple(address(this), plan.marketParams.loanToken, flashAmount, callbackData, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external onlyFork returns (bool) {
        require(msg.sender == address(aavePool), "ONLY_AAVE_POOL");
        require(initiator == address(this), "BAD_INITIATOR");

        LiquidationPlan memory plan = abi.decode(params, (LiquidationPlan));
        require(asset == plan.marketParams.loanToken, "FLASH_ASSET_MISMATCH");

        _forceApprove(asset, address(morpho), amount);
        (uint256 seizedOut, uint256 repaidOut, uint256 badDebtAssets, uint256 badDebtShares) = morpho.liquidate(
            plan.marketParams,
            plan.borrower,
            plan.seizedAssets,
            plan.repaidShares,
            bytes("")
        );
        require(seizedOut > 0 && repaidOut > 0, "MORPHO_LIQUIDATION_EMPTY");
        require(badDebtAssets == 0 && badDebtShares == 0, "MORPHO_BAD_DEBT_REMAINS");
        require(repaidOut <= amount, "FLASH_AMOUNT_TOO_SMALL");

        _forceApprove(plan.marketParams.collateralToken, address(swapRouter), seizedOut);
        uint256 requiredOutput = amount + premium + plan.minProfit;
        uint256 output = swapRouter.exactInput(
            IUniswapV3RouterMinimal.ExactInputParams({
                path: plan.swapPath,
                recipient: address(this),
                deadline: plan.deadline,
                amountIn: seizedOut,
                amountOutMinimum: requiredOutput
            })
        );
        require(output >= requiredOutput, "UNPROFITABLE_AFTER_FLASH_FEE");

        _forceApprove(asset, address(aavePool), amount + premium);
        emit ForkLiquidationSimulated(
            plan.borrower,
            asset,
            plan.marketParams.collateralToken,
            repaidOut,
            seizedOut,
            output,
            premium,
            plan.minProfit
        );
        return true;
    }

    function _forceApprove(address token, address spender, uint256 value) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, 0)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "APPROVE_RESET_FAILED");
        (ok, result) = token.call(
            abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, value)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "APPROVE_FAILED");
    }

    function _firstToken(bytes memory path) private pure returns (address token) {
        assembly { token := shr(96, mload(add(path, 32))) }
    }

    function _lastToken(bytes memory path) private pure returns (address token) {
        uint256 offset = path.length - 20;
        assembly { token := shr(96, mload(add(add(path, 32), offset))) }
    }
}
