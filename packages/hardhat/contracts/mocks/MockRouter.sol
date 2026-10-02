// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHederaTokenService } from "../interfaces/IHederaTokenService.sol";
import { ISaucerSwapRouter } from "../interfaces/ISaucerSwapRouter.sol";

/// @notice Constant-price stand-in for the SaucerSwap V1 router. It pays out of its own USDC balance
/// through HTS, so the recipient must be associated, exactly as with the real router on Hedera.
contract MockRouter is ISaucerSwapRouter {
    IHederaTokenService private constant HTS = IHederaTokenService(address(0x167));

    address public immutable whbar;
    address public immutable usdc;
    /// @notice USDC (6 decimals) paid per whole HBAR. 99_000 = 0.099 USDC per HBAR.
    uint256 public usdcPerHbar;

    constructor(address whbar_, address usdc_, uint256 usdcPerHbar_) {
        whbar = whbar_;
        usdc = usdc_;
        usdcPerHbar = usdcPerHbar_;
        require(HTS.associateToken(address(this), usdc_) == 22, "MockRouter: association failed");
    }

    /// @notice Move the pool price, e.g. to simulate a thin or manipulated pool.
    function setUsdcPerHbar(uint256 usdcPerHbar_) external {
        usdcPerHbar = usdcPerHbar_;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        require(path.length == 2 && path[0] == whbar && path[1] == usdc, "MockRouter: bad path");
        require(amountIn > 0, "MockRouter: INSUFFICIENT_INPUT_AMOUNT");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * usdcPerHbar) / 1e8;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "MockRouter: EXPIRED");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[1] >= amountOutMin, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        require(HTS.transferToken(usdc, address(this), to, int64(uint64(amounts[1]))) == 22, "MockRouter: HTS");
    }
}
