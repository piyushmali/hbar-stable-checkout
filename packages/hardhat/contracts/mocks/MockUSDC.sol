// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stand-in for the USDC HTS token. The router mock and StableCheckout move it through the
/// HTS system contract (MockHTS at 0x167), which enforces association the way Hedera does.
contract MockUSDC is ERC20 {
    address private constant HTS = address(0x167);

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function htsTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == HTS, "MockUSDC: only HTS");
        _transfer(from, to, amount);
    }
}
