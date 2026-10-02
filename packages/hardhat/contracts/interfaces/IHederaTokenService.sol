// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of the Hedera Token Service system contract at 0x167.
/// @dev Signatures match the official IHederaTokenService. Both calls return a Hedera response code
/// (22 = SUCCESS) instead of reverting, so callers must check it.
/// https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts/hedera-token-service
interface IHederaTokenService {
    function associateToken(address account, address token) external returns (int64 responseCode);

    function transferToken(
        address token,
        address sender,
        address recipient,
        int64 amount
    ) external returns (int64 responseCode);
}
