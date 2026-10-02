// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHederaTokenService } from "../interfaces/IHederaTokenService.sol";
import { MockUSDC } from "./MockUSDC.sol";

/// @notice Hermetic stand-in for the HTS system contract. Tests install its runtime code at 0x167 with
/// hardhat_setCode, so storage starts empty and nothing may depend on a constructor.
/// It reproduces the HTS rules StableCheckout relies on: accounts must be associated to hold a token,
/// only the owner can move its balance, and failures come back as response codes rather than reverts.
contract MockHTS is IHederaTokenService {
    int64 private constant SUCCESS = 22;
    int64 private constant INVALID_SIGNATURE = 7;
    int64 private constant INSUFFICIENT_TOKEN_BALANCE = 178;
    int64 private constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 private constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    mapping(address token => mapping(address account => bool)) public isAssociated;
    /// @notice When non-zero, associateToken returns this code instead of associating.
    int64 public forcedAssociateCode;

    function setForcedAssociateCode(int64 responseCode) external {
        forcedAssociateCode = responseCode;
    }

    function associateToken(address account, address token) external returns (int64) {
        if (forcedAssociateCode != 0) return forcedAssociateCode;
        if (account != msg.sender) return INVALID_SIGNATURE;
        if (isAssociated[token][account]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        isAssociated[token][account] = true;
        return SUCCESS;
    }

    function transferToken(address token, address sender, address recipient, int64 amount) external returns (int64) {
        if (sender != msg.sender || amount < 0) return INVALID_SIGNATURE;
        if (!isAssociated[token][sender] || !isAssociated[token][recipient]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        uint256 value = uint256(uint64(amount));
        if (MockUSDC(token).balanceOf(sender) < value) return INSUFFICIENT_TOKEN_BALANCE;
        MockUSDC(token).htsTransfer(sender, recipient, value);
        return SUCCESS;
    }
}
