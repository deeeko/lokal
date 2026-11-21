// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IPots {
    function payPot(uint256 potId, address token, uint256 amount, bytes32 ref, address expectedPayout) external;
}

interface IApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Test-only: a payer contract whose token hook (HookERC20 calls `onSend` on the sender) re-enters `payPot`.
contract ReentrantPotPayer {
    IPots public immutable pots;
    uint256 public potId;
    address public innerToken;
    uint256 public innerAmount;
    bool private _done;

    constructor(IPots p) {
        pots = p;
    }

    function approve(address token, address spender) external {
        IApprove(token).approve(spender, type(uint256).max);
    }

    function setInner(uint256 id, address token, uint256 amount) external {
        potId = id;
        innerToken = token;
        innerAmount = amount;
        _done = false;
    }

    function pay(uint256 id, address token, uint256 amount) external {
        pots.payPot(id, token, amount, bytes32("outer"), address(0));
    }

    function onSend() external {
        if (_done || innerToken == address(0)) return;
        _done = true;
        pots.payPot(potId, innerToken, innerAmount, bytes32("inner"), address(0));
    }
}
