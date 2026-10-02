// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AggregatorV3Interface } from "../interfaces/AggregatorV3Interface.sol";

/// @notice Settable Chainlink feed for tests.
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable decimals;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_, int256 answer) {
        decimals = decimals_;
        setAnswer(answer);
    }

    /// @notice Publish a fresh, complete round.
    function setAnswer(int256 answer) public {
        _roundId++;
        setRound(_roundId, answer, block.timestamp, _roundId);
    }

    /// @notice Publish an arbitrary round, e.g. a stale or incomplete one.
    function setRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) public {
        (_roundId, _answer, _updatedAt, _answeredInRound) = (roundId, answer, updatedAt, answeredInRound);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _answeredInRound);
    }
}
