// SPDX-License-Identifier: MIT
// Test-only attack contracts from the independent audit (ported; tests/Attack.spec.ts). Never deployed.
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ISendHook { function onSend() external; }

/// Token that calls `from.onSend()` before moving tokens when `from` has code (ERC-777 style hook; "cNGN upgraded to the worst").
contract HookERC20 is ERC20 {
    constructor() ERC20("Hook", "HOOK") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && from.code.length > 0) ISendHook(from).onSend();
        super._update(from, to, v);
    }
}

/// Token that re-enters an arbitrary target from inside transferFrom, as itself.
contract SelfReentrantERC20 is ERC20 {
    address public hookTarget; bytes public hookData; bool private _in;
    constructor() ERC20("Re", "RE") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function arm(address t, bytes calldata d) external { hookTarget = t; hookData = d; }
    function selfApprove(address spender, uint256 a) external { _approve(address(this), spender, a); }
    function transferFrom(address from, address to, uint256 v) public override returns (bool) {
        if (hookTarget != address(0) && !_in) {
            _in = true;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
            _in = false;
        }
        return super.transferFrom(from, to, v);
    }
}

/// transferFrom returns false and moves nothing.
contract FalseERC20 is ERC20 {
    constructor() ERC20("False", "F") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function transferFrom(address, address, uint256) public pure override returns (bool) { return false; }
}

/// transferFrom returns true and moves nothing.
contract LyingERC20 is ERC20 {
    constructor() ERC20("Lie", "L") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function transferFrom(address, address, uint256) public pure override returns (bool) { return true; }
}

/// Legacy USDT-style: transferFrom returns nothing.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function decimals() external pure returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transferFrom(address f, address t, uint256 a) external {
        require(allowance[f][msg.sender] >= a && balanceOf[f] >= a);
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a;
    }
}

interface ITags {
    function payTag(string calldata tag, address token, uint256 amount, bytes32 ref, address expectedPayout) external;
    function claim(string calldata tag, string calldata name) external;
}
interface IERC20x { function approve(address, uint256) external returns (bool); }

/// A payer contract that re-enters payTag from the token's send hook.
contract ReentrantPayer is ISendHook {
    ITags public tags; string public tag; address public token; uint256 public amount; bool private _done;
    constructor(ITags t) { tags = t; }
    function approve(address tok, address spender) external { IERC20x(tok).approve(spender, type(uint256).max); }
    function setInner(string calldata tg, address tok, uint256 a) external { tag = tg; token = tok; amount = a; _done = false; }
    function pay(string calldata tg, address tok, uint256 a) external { tags.payTag(tg, tok, a, bytes32(0), address(0)); }
    function onSend() external {
        if (_done || token == address(0)) return;
        _done = true;
        tags.payTag(tag, token, amount, bytes32("inner"), address(0));
    }
}

/// Claims a tag in its constructor and self-destructs in the same transaction (EIP-6780: account is deleted).
contract ClaimAndVanish {
    constructor(ITags t, string memory tg) { t.claim(tg, ""); selfdestruct(payable(msg.sender)); }
}

/// CREATE2 factory, so the vanished address can be re-created later.
contract Create2Factory {
    event Deployed(address a);
    function deploy(bytes32 salt, bytes memory code) external returns (address a) {
        assembly { a := create2(0, add(code, 32), mload(code), salt) }
        require(a != address(0), "create2 failed");
        emit Deployed(a);
    }
    function predict(bytes32 salt, bytes32 codeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
}
