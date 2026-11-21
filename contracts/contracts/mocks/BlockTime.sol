// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Test-only: the block timestamp a view call sees, so tests compare against exactly what the contract sees.
contract BlockTime {
    function timestamp() external view returns (uint256) {
        return block.timestamp;
    }
}
