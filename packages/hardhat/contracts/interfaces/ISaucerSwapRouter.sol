// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of the SaucerSwap V1 router (Uniswap V2 style) used by StableCheckout.
/// @dev https://docs.saucerswap.finance/developers/v1/swap/swap-hbar-for-tokens
/// The router wraps the HBAR it receives into WHBAR, so path[0] is the WHBAR token (not the WHBAR contract).
/// Inside the Hedera EVM every HBAR amount, including msg.value and `amountIn`, is in tinybars (8 decimals).
interface ISaucerSwapRouter {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}
