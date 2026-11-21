// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ILokalTagsClaim {
    function claim(string calldata tag, string calldata name) external;
}

/// @notice Test-only smart contract that tries to hold a tag, either later (`claim`) or from its constructor.
contract TagClaimer {
    constructor(ILokalTagsClaim registry, string memory tag) {
        if (bytes(tag).length != 0) registry.claim(tag, "");
    }

    function claim(ILokalTagsClaim registry, string calldata tag) external {
        registry.claim(tag, "");
    }
}
