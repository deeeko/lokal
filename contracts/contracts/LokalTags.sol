// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LokalText} from "./LokalText.sol";

/**
 * @title LokalTags
 * @notice The tag registry and payment router for Lokal, the Celo agent that pays anyone in their local money.
 * People claim a handle (tag) such as "ada" from their own wallet, and anyone can pay that handle in an allowed
 * stablecoin (USD₮, cNGN, IDRX, wARS, wCOP, ...).
 * The payment goes straight from the payer to the agent's payout wallet, and the agent then pays the tag's owner in
 * their local currency (or in dollars), off this contract. A tag owner may name a preferred receive token.
 *
 * The agent decides; the contract has the final say. Every rule that can be checked before money moves is checked
 * here, so a payment the agent would have to refuse never arrives:
 *  - tag format, reserved names, one tag per wallet and the 30-day release lock;
 *  - per-token limits: a minimum and a maximum per payment, a maximum per recipient and per payer per UTC day, and a
 *    maximum overall per UTC day;
 *  - no paying yourself, no paying a smart contract or the payout wallet itself, and a pause switch.
 *
 * The contract never holds funds: `payTag` moves tokens from the payer directly to `payoutWallet` in one
 * `transferFrom`. There is no upgrade path, and the admin has no function that takes a tag from its owner or moves
 * anyone's tokens (`rescue` only returns tokens someone sent to this contract by mistake). A new payout wallet takes
 * effect only 24 hours after it is proposed, and a payer can pin the payout wallet they expect.
 * @dev Storage layout is packed for the hot paths: one slot per tag, one slot per holder, three slots of limits per
 * token and one usage slot per token, per (token, recipient) and per (token, payer), each holding the current UTC day
 * and its total.
 * Limits are uint128 in each token's own units, so tokens with 2, 6 or 18 decimals all fit with room to spare.
 */
contract LokalTags is Ownable2Step {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice What `claimer` would get if it claimed a tag now. Same names and order of checks as the site.
    enum Availability {
        Free, // nobody holds it and no lock applies to the claimer
        Yours, // the claimer already holds it
        Taken, // someone else holds it
        Reserved, // on the reserved list
        Locked, // released less than 30 days ago by someone else
        Invalid // breaks the format rules
    }

    /**
     * @notice One tag's record. While held, `account` is the owner and `lockedUntil` is 0. After a release, `account`
     * is the previous owner and `lockedUntil` the end of the lock (which may be in the past).
     */
    struct TagRecord {
        address account;
        uint40 since;
        uint40 lockedUntil;
    }

    /// @notice Per-token limits in the token's own units. `maxPerPayment == 0` means the token is not allowed.
    struct TokenLimits {
        uint128 minPerPayment;
        uint128 maxPerPayment;
        uint128 maxPerRecipientPerDay;
        uint128 maxPerPayerPerDay;
        uint128 maxPerDay;
    }

    /// @notice Constructor input: a token and its limits.
    struct TokenSetup {
        address token;
        TokenLimits limits;
    }

    /// @notice An amount used during one UTC day (`day` = `block.timestamp / 1 days`).
    struct DayUsage {
        uint64 day;
        uint192 used;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice How long a released tag stays locked for everyone but its previous owner.
    uint256 public constant RELEASE_LOCK = 30 days;
    /// @notice Shortest tag, in bytes.
    uint256 public constant MIN_TAG_LENGTH = 3;
    /// @notice Longest tag, in bytes.
    uint256 public constant MAX_TAG_LENGTH = 20;
    /// @notice Longest display name, counted the way the site counts it (UTF-16 code units, like JavaScript's length).
    uint256 public constant MAX_NAME_UNITS = 40;
    /// @notice Hard byte bound on a name, so validation is always a short bounded loop (40 units is at most 120 bytes).
    uint256 public constant MAX_NAME_BYTES = 120;
    /// @notice Most tags one `setReserved` call (or the constructor) may touch.
    uint256 public constant MAX_RESERVED_BATCH = 128;
    /// @notice How long a proposed payout wallet waits before it can take effect.
    uint256 public constant PAYOUT_WALLET_DELAY = 24 hours;

    // ---------------------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Where every payment goes: the agent's payout wallet.
    address public payoutWallet;
    /// @notice While true, claims, renames and payments revert with `Paused`. Releasing a tag always works.
    bool public paused;
    /// @notice A proposed payout wallet (zero for none).
    address public pendingPayoutWallet;
    /// @notice The earliest time `pendingPayoutWallet` can take effect.
    uint40 public pendingPayoutWalletEta;

    /// @dev keccak256(tag) => record.
    mapping(bytes32 tagHash => TagRecord) private _records;
    /// @dev holder => their tag's text, left-aligned and zero-padded (tags are at most 20 bytes and never contain 0x00).
    mapping(address holder => bytes20) private _tagOf;
    /// @dev holder => display name ("" for none). Cleared when the tag is released.
    mapping(address holder => string) private _nameOf;
    /// @dev holder => preferred receive token (zero for none: the agent decides by corridor). Cleared on release.
    mapping(address holder => address) private _receiveTokenOf;
    /// @notice keccak256(tag) => true when nobody may claim the tag.
    mapping(bytes32 tagHash => bool) public reserved;
    /// @notice token => limits. All zero means the token is not allowed.
    mapping(address token => TokenLimits) public tokenLimits;
    /// @dev token => what all payments in that token added up to on `day`.
    mapping(address token => DayUsage) private _dailyUsage;
    /// @dev token => recipient => what that recipient was paid in that token on `day`.
    mapping(address token => mapping(address recipient => DayUsage)) private _recipientUsage;
    /// @dev token => payer => what that payer paid in that token on `day`.
    mapping(address token => mapping(address payer => DayUsage)) private _payerUsage;

    // ---------------------------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice `owner` now holds `tag`. `name` is the display name ("" for none).
    event TagClaimed(bytes32 indexed tagHash, string tag, address indexed owner, string name);
    /// @notice `previousOwner` gave up `tag` (by `release` or by claiming another tag). Locked for others until `lockedUntil`.
    event TagReleased(bytes32 indexed tagHash, string tag, address indexed previousOwner, uint256 lockedUntil);
    /// @notice The display name on `tag` changed to `name` ("" clears it).
    event NameChanged(bytes32 indexed tagHash, string tag, address indexed owner, string name);
    /**
     * @notice `payer` paid `amount` of `token` to `tag`, held by `recipient` at that moment. The tokens are already in
     * the payout wallet. `ref` is the payer's own reference (opaque to the contract). `dayIndex` is the UTC day the
     * payment counted toward (`block.timestamp / 1 days`).
     */
    event TagPaid(
        bytes32 indexed tagHash,
        string tag,
        address indexed recipient,
        address indexed payer,
        address token,
        uint256 amount,
        bytes32 ref,
        uint256 dayIndex
    );
    /// @notice The owner of `tag` asked to be paid out in `token` (zero: no preference).
    event ReceiveTokenSet(bytes32 indexed tagHash, string tag, address indexed owner, address indexed token);
    /// @notice New limits for `token`. All zero means the token is no longer allowed.
    event TokenLimitsSet(
        address indexed token,
        uint256 minPerPayment,
        uint256 maxPerPayment,
        uint256 maxPerRecipientPerDay,
        uint256 maxPerPayerPerDay,
        uint256 maxPerDay
    );
    /// @notice Payments now go to `current` instead of `previous`.
    event PayoutWalletSet(address indexed previous, address indexed current);
    /// @notice `proposed` will be able to replace the payout wallet from `eta` on.
    event PayoutWalletProposed(address indexed current, address indexed proposed, uint256 eta);
    /// @notice The proposal for `proposed` was withdrawn.
    event PayoutWalletCancelled(address indexed proposed);
    /// @notice `amount` of `token` that was sent to this contract by mistake was returned to `to`.
    event Rescued(address indexed token, address indexed to, uint256 amount);
    /// @notice `tag` was added to (`isReserved` true) or removed from the reserved list.
    event ReservedSet(bytes32 indexed tagHash, string tag, bool isReserved);
    /// @notice The pause switch was turned on or off by `by`.
    event PausedSet(bool isPaused, address indexed by);

    // ---------------------------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice The tag breaks the format rules (`^[a-z][a-z0-9_]{2,19}$`, no "__", no trailing "_").
    error InvalidTag();
    /// @notice The display name is too long, not valid UTF-8, has a control character or starts/ends with whitespace.
    error InvalidName();
    /// @notice The tag is on the reserved list.
    error TagReserved();
    /// @notice Someone else holds the tag.
    error TagTaken(address owner);
    /// @notice The caller already holds this tag. Use `setName` to change the name.
    error AlreadyYours();
    /// @notice The tag was released by someone else less than 30 days ago.
    error TagLocked(uint256 lockedUntil);
    /// @notice The caller holds no tag.
    error NoTag();
    /// @notice Nobody holds the tag.
    error TagNotFound();
    /// @notice The token is not on the allowed list.
    error TokenNotAllowed(address token);
    /// @notice The amount is under the token's minimum per payment.
    error BelowMinimum(uint256 amount, uint256 minimum);
    /// @notice The amount is over the token's maximum per payment.
    error OverPaymentLimit(uint256 amount, uint256 maximum);
    /// @notice The recipient would get more than the per-recipient daily maximum in this token today.
    error OverRecipientDailyLimit(uint256 amount, uint256 remainingToday);
    /// @notice The payer would pay more than the per-payer daily maximum in this token today.
    error OverPayerDailyLimit(uint256 amount, uint256 remainingToday);
    /// @notice All payments in this token would add up to more than the daily maximum today.
    error OverDailyLimit(uint256 amount, uint256 remainingToday);
    /// @notice The payer holds the tag being paid.
    error SelfPayment();
    /// @notice The address is a smart contract (EIP-7702 delegated wallets are fine), so it can't hold a tag or be paid.
    error RecipientIsContract(address account);
    /// @notice The payout wallet can't hold a tag or be paid through a tag.
    error RecipientIsPayoutWallet();
    /// @notice Claims, renames and payments are paused.
    error Paused();
    /// @notice The payout wallet did not receive exactly `amount` (fee-on-transfer or otherwise non-standard token).
    error TransferAmountMismatch(uint256 expected, uint256 received);
    /// @notice The payout wallet is not the one the payer expected (it was changed).
    error PayoutWalletChanged(address current);
    /// @notice No payout wallet change is pending, or its 24 hours have not passed yet.
    error PayoutWalletNotReady(uint256 eta);
    /// @notice Limits must be all zero (disallow) or satisfy 0 < min <= max <= perRecipientPerDay <= perDay and
    /// max <= perPayerPerDay <= perDay.
    error InvalidLimits();
    /// @notice The token address has no code.
    error InvalidToken(address token);
    /// @notice The payout wallet (or a rescue destination) can't be the zero address or this contract.
    error InvalidPayoutWallet(address wallet);
    /// @notice A reserve request touched a tag that is currently held or inside its release lock.
    error TagInUse();
    /// @notice Too many tags in one `setReserved` call.
    error BatchTooLarge(uint256 length);
    /// @notice The pause switch is already in the requested position.
    error PauseUnchanged();
    /// @notice Ownership can be handed over (two steps) but never renounced.
    error RenounceDisabled();

    // ---------------------------------------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Deploys the registry with its payout wallet, reserved list and token limits in one transaction, so no
     * reserved tag can be claimed and no payment accepted before the rules are in place. The deployer becomes the
     * admin (two-step transferable, never renounceable).
     * @param payoutWallet_ The agent's payout wallet.
     * @param reservedTags Tags nobody may claim (at most `MAX_RESERVED_BATCH`).
     * @param tokens Allowed tokens and their limits.
     */
    constructor(address payoutWallet_, string[] memory reservedTags, TokenSetup[] memory tokens) Ownable(msg.sender) {
        _setPayoutWallet(payoutWallet_);
        _setReserved(reservedTags, true);
        for (uint256 i; i < tokens.length; ++i) {
            _setTokenLimits(tokens[i].token, tokens[i].limits);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Registry: writes
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Claims `tag` for the caller with an optional display name. If the caller already holds another tag,
     * that tag is released first (and locked for 30 days for everyone else).
     * @param tag Lowercase tag without "@", for example "ada".
     * @param name Display name, "" for none. At most 40 characters, no control characters, no whitespace at either end.
     */
    function claim(string calldata tag, string calldata name) external {
        if (paused) revert Paused();
        if (!_isValidTag(bytes(tag))) revert InvalidTag();
        bytes32 tagHash = keccak256(bytes(tag));
        if (reserved[tagHash]) revert TagReserved();
        if (!_isValidName(bytes(name))) revert InvalidName();
        _checkCanBePaid(msg.sender);

        TagRecord memory r = _records[tagHash];
        if (r.account != address(0)) {
            if (r.lockedUntil == 0) {
                if (r.account == msg.sender) revert AlreadyYours();
                revert TagTaken(r.account);
            }
            if (r.lockedUntil > block.timestamp && r.account != msg.sender) revert TagLocked(r.lockedUntil);
        }

        bytes20 current = _tagOf[msg.sender];
        if (current != bytes20(0)) _release(msg.sender, current);

        _records[tagHash] = TagRecord({account: msg.sender, since: uint40(block.timestamp), lockedUntil: 0});
        _tagOf[msg.sender] = bytes20(bytes(tag));
        if (bytes(name).length != 0) _nameOf[msg.sender] = name;
        emit TagClaimed(tagHash, tag, msg.sender, name);
    }

    /**
     * @notice Changes the display name on the caller's tag.
     * @param name New display name, "" to clear it. Same rules as in `claim`.
     */
    function setName(string calldata name) external {
        if (paused) revert Paused();
        bytes20 current = _tagOf[msg.sender];
        if (current == bytes20(0)) revert NoTag();
        if (!_isValidName(bytes(name))) revert InvalidName();
        _nameOf[msg.sender] = name;
        string memory tag = _text(current);
        emit NameChanged(keccak256(bytes(tag)), tag, msg.sender, name);
    }

    /**
     * @notice Sets the token the caller would like to be paid out in (their local currency), or clears it with the
     * zero address. Only an allowed token can be chosen. It is a preference for the agent, not a rule: payments to the
     * tag are still accepted in any allowed token.
     * @param token An allowed token, or address(0) for no preference.
     */
    function setReceiveToken(address token) external {
        if (paused) revert Paused();
        bytes20 current = _tagOf[msg.sender];
        if (current == bytes20(0)) revert NoTag();
        if (token != address(0) && tokenLimits[token].maxPerPayment == 0) revert TokenNotAllowed(token);
        _receiveTokenOf[msg.sender] = token;
        string memory tag = _text(current);
        emit ReceiveTokenSet(keccak256(bytes(tag)), tag, msg.sender, token);
    }

    /**
     * @notice Gives up the caller's tag. It stays locked for 30 days for everyone but the caller. Works while paused.
     */
    function release() external {
        bytes20 current = _tagOf[msg.sender];
        if (current == bytes20(0)) revert NoTag();
        _release(msg.sender, current);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Router
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Pays `tag` `amount` of `token`. Every limit is checked first; then the tokens go straight from the
     * caller to `payoutWallet` (the caller must have approved this contract for `amount`). Nothing stays here.
     * @param tag The tag to pay, lowercase without "@".
     * @param token An allowed token (see `tokenLimits`).
     * @param amount Amount in the token's own units (each token has its own decimals: USD₮ 6, IDRX 2, wCOP 18).
     * @param ref The payer's own reference, echoed in `TagPaid` (for example a hash of an invoice id). Opaque here.
     * @param expectedPayout The payout wallet the payer expects (from `payoutWallet()`); reverts `PayoutWalletChanged`
     * if it differs. Zero skips the check.
     */
    function payTag(string calldata tag, address token, uint256 amount, bytes32 ref, address expectedPayout) external {
        _pay(tag, token, amount, ref, expectedPayout);
    }

    /**
     * @notice `payTag` with an EIP-2612 permit, so the payer signs once and sends one transaction instead of two.
     * USD₮ on Celo supports permit; cNGN does not (use `approve` + `payTag` for tokens without permit).
     * @dev The permit is wrapped in try/catch: if someone front-runs it with the same signature the allowance is
     * already in place and the payment still goes through; if the permit was bad, `transferFrom` reverts.
     * Limits are checked before the token is called at all.
     * @param tag The tag to pay.
     * @param token An allowed token that implements EIP-2612.
     * @param amount Amount in the token's units; the permit must be for exactly this amount, spender this contract.
     * @param ref The payer's own reference.
     * @param expectedPayout The payout wallet the payer expects, or zero to skip the check.
     * @param deadline Permit deadline.
     * @param v Signature v.
     * @param r Signature r.
     * @param s Signature s.
     */
    function payTagWithPermit(
        string calldata tag,
        address token,
        uint256 amount,
        bytes32 ref,
        address expectedPayout,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _checkExpectedPayout(expectedPayout);
        _validatePayment(tag, token, amount, msg.sender);
        try IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(tag, token, amount, ref, expectedPayout);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Sets the limits for `token`, in its own units. All zero disallows it. Otherwise
     * 0 < min <= max <= maxPerRecipientPerDay <= maxPerDay and max <= maxPerPayerPerDay <= maxPerDay. Today's usage
     * is kept, so a lower cap applies at once.
     * @param token The token.
     * @param minPerPayment Smallest payment.
     * @param maxPerPayment Largest payment.
     * @param maxPerRecipientPerDay Most one recipient may be paid per UTC day.
     * @param maxPerPayerPerDay Most one payer may pay per UTC day.
     * @param maxPerDay Most in total per UTC day.
     */
    function setTokenLimits(
        address token,
        uint128 minPerPayment,
        uint128 maxPerPayment,
        uint128 maxPerRecipientPerDay,
        uint128 maxPerPayerPerDay,
        uint128 maxPerDay
    ) external onlyOwner {
        _setTokenLimits(
            token, TokenLimits(minPerPayment, maxPerPayment, maxPerRecipientPerDay, maxPerPayerPerDay, maxPerDay)
        );
    }

    /**
     * @notice Proposes a new payout wallet. It can take effect 24 hours from now (`executePayoutWallet`), so anyone
     * watching `PayoutWalletProposed` has a day to notice. A new proposal replaces the pending one.
     * @param wallet The new payout wallet: not zero, not this contract.
     */
    function proposePayoutWallet(address wallet) external onlyOwner {
        if (wallet == address(0) || wallet == address(this)) revert InvalidPayoutWallet(wallet);
        uint256 eta = block.timestamp + PAYOUT_WALLET_DELAY;
        pendingPayoutWallet = wallet;
        pendingPayoutWalletEta = uint40(eta);
        emit PayoutWalletProposed(payoutWallet, wallet, eta);
    }

    /// @notice Makes the pending payout wallet the payout wallet, once its 24 hours have passed.
    function executePayoutWallet() external onlyOwner {
        address wallet = pendingPayoutWallet;
        uint256 eta = pendingPayoutWalletEta;
        if (wallet == address(0) || block.timestamp < eta) revert PayoutWalletNotReady(eta);
        delete pendingPayoutWallet;
        delete pendingPayoutWalletEta;
        _setPayoutWallet(wallet);
    }

    /// @notice Withdraws the pending payout wallet proposal.
    function cancelPayoutWallet() external onlyOwner {
        address wallet = pendingPayoutWallet;
        if (wallet == address(0)) revert PayoutWalletNotReady(0);
        delete pendingPayoutWallet;
        delete pendingPayoutWalletEta;
        emit PayoutWalletCancelled(wallet);
    }

    /**
     * @notice Returns tokens that were sent to this contract by mistake. Nothing is ever held here legitimately
     * (payments go straight to the payout wallet), so this can't touch anyone's payment or allowance.
     * On Celo this also covers native CELO, through its ERC-20 interface.
     * @param token The token.
     * @param to Where to send it.
     * @param amount How much.
     */
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert InvalidPayoutWallet(to);
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /**
     * @notice Adds tags to, or removes them from, the reserved list. A tag that is held or inside its release lock
     * can't be reserved, so this can never take a tag from anyone.
     * @param tags Up to `MAX_RESERVED_BATCH` tags.
     * @param value True to reserve, false to free.
     */
    function setReserved(string[] calldata tags, bool value) external onlyOwner {
        _setReserved(tags, value);
    }

    /// @notice Stops claims, renames and payments. Releasing a tag still works.
    function pause() external onlyOwner {
        _setPaused(true);
    }

    /// @notice Lets claims, renames and payments through again.
    function unpause() external onlyOwner {
        _setPaused(false);
    }

    /// @notice Disabled: the registry always has an admin who can pause it.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// @notice Who holds `tag`, or the zero address.
    function ownerOf(string calldata tag) external view returns (address) {
        TagRecord memory r = _records[keccak256(bytes(tag))];
        return r.lockedUntil == 0 ? r.account : address(0);
    }

    /// @notice The tag `holder` holds, or "".
    function tagOf(address holder) external view returns (string memory) {
        return _text(_tagOf[holder]);
    }

    /// @notice `holder`'s preferred receive token, or zero (none set, or the token is no longer allowed).
    function receiveTokenOf(address holder) public view returns (address token) {
        token = _receiveTokenOf[holder];
        if (token != address(0) && tokenLimits[token].maxPerPayment == 0) token = address(0);
    }

    /// @notice The display name on `holder`'s tag, or "".
    function nameOf(address holder) external view returns (string memory) {
        return _nameOf[holder];
    }

    /**
     * @notice Everything a tag page needs in one call.
     * @return owner Holder (zero if none).
     * @return name Display name ("" for none).
     * @return since Claim time (0 if not held).
     * @return lockedFor Previous owner while a release lock is running (else zero).
     * @return lockedUntil End of that lock (0 if none is running).
     * @return receiveToken The holder's preferred receive token (zero for none).
     */
    function tagInfo(string calldata tag)
        external
        view
        returns (
            address owner,
            string memory name,
            uint256 since,
            address lockedFor,
            uint256 lockedUntil,
            address receiveToken
        )
    {
        TagRecord memory r = _records[keccak256(bytes(tag))];
        if (r.lockedUntil == 0) {
            if (r.account != address(0)) {
                return (r.account, _nameOf[r.account], r.since, address(0), 0, receiveTokenOf(r.account));
            }
        } else if (r.lockedUntil > block.timestamp) {
            return (address(0), "", 0, r.account, r.lockedUntil, address(0));
        }
    }

    /**
     * @notice What `claimer` would get by claiming `tag` now, checked in the site's order: Invalid, Reserved,
     * Yours/Taken, Locked, Free.
     */
    function availability(string calldata tag, address claimer) external view returns (Availability) {
        if (!_isValidTag(bytes(tag))) return Availability.Invalid;
        bytes32 tagHash = keccak256(bytes(tag));
        if (reserved[tagHash]) return Availability.Reserved;
        TagRecord memory r = _records[tagHash];
        if (r.account != address(0)) {
            if (r.lockedUntil == 0) return r.account == claimer ? Availability.Yours : Availability.Taken;
            if (r.lockedUntil > block.timestamp && r.account != claimer) return Availability.Locked;
        }
        return Availability.Free;
    }

    /**
     * @notice What a router built on this registry (LokalPots) needs in one call: where money goes, whether
     * everything is paused, whether `recipient` may be paid through a tag right now, and `token`'s limits.
     * @param recipient The wallet to be paid.
     * @param token The token to be paid in.
     * @return payout The payout wallet.
     * @return isPaused The pause switch.
     * @return recipientOk True when `recipient` holds a tag, is not the payout wallet and is not a smart contract.
     * @return minPerPayment `token`'s minimum per payment (0 when the token is not allowed).
     * @return maxPerPayment `token`'s maximum per payment (0 when the token is not allowed).
     */
    function routeInfo(address recipient, address token)
        external
        view
        returns (address payout, bool isPaused, bool recipientOk, uint256 minPerPayment, uint256 maxPerPayment)
    {
        payout = payoutWallet;
        isPaused = paused;
        recipientOk = _tagOf[recipient] != bytes20(0) && recipient != payout && !_isContract(recipient);
        TokenLimits memory l = tokenLimits[token];
        return (payout, isPaused, recipientOk, l.minPerPayment, l.maxPerPayment);
    }

    /// @notice True when `tag` has the right format (reserved list not checked).
    function isValidTag(string calldata tag) external pure returns (bool) {
        return _isValidTag(bytes(tag));
    }

    /// @notice True when `name` is an acceptable display name ("" included).
    function isValidName(string calldata name) external pure returns (bool) {
        return _isValidName(bytes(name));
    }

    /// @notice True when `tag` is on the reserved list.
    function isReserved(string calldata tag) external view returns (bool) {
        return reserved[keccak256(bytes(tag))];
    }

    /**
     * @notice Dry run of a payment: reverts with exactly the error `payTag` would hit (except token balance and
     * allowance), else returns who would be paid. Use it (eth_call) to explain a refusal before asking for a signature.
     * @return recipient The tag's holder.
     * @return dayIndex The UTC day the payment would count toward.
     */
    function validatePayment(string calldata tag, address token, uint256 amount, address payer)
        external
        view
        returns (address recipient, uint256 dayIndex)
    {
        Check memory c = _validatePayment(tag, token, amount, payer);
        return (c.recipient, c.day);
    }

    /**
     * @notice How much more can be paid today in `token`: to `recipient`, by `payer`, and overall. The real room for
     * one payment is the smallest of the three, capped at `maxPerPayment`.
     * @return forRecipient Left under the per-recipient cap.
     * @return forPayer Left under the per-payer cap.
     * @return overall Left under the overall daily cap.
     */
    function remainingToday(address token, address recipient, address payer)
        external
        view
        returns (uint256 forRecipient, uint256 forPayer, uint256 overall)
    {
        TokenLimits memory l = tokenLimits[token];
        uint64 day = uint64(block.timestamp / 1 days);
        forRecipient = _room(l.maxPerRecipientPerDay, _usedOn(_recipientUsage[token][recipient], day));
        forPayer = _room(l.maxPerPayerPerDay, _usedOn(_payerUsage[token][payer], day));
        overall = _room(l.maxPerDay, _usedOn(_dailyUsage[token], day));
    }

    /**
     * @notice What `account` received and paid in `token` during UTC day `day`, and what all payments in it added up to.
     * @return asRecipient Paid to `account`.
     * @return asPayer Paid by `account`.
     * @return overall All payments in `token`.
     */
    function usedOn(address token, address account, uint256 day)
        external
        view
        returns (uint256 asRecipient, uint256 asPayer, uint256 overall)
    {
        return (
            _usedOn(_recipientUsage[token][account], day),
            _usedOn(_payerUsage[token][account], day),
            _usedOn(_dailyUsage[token], day)
        );
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The result of a successful payment check.
    struct Check {
        bytes32 tagHash;
        address recipient;
        uint64 day;
        uint256 recipientUsed;
        uint256 payerUsed;
        uint256 dailyUsed;
    }

    /// @dev Checks, effects (usage), then one transfer straight to the payout wallet.
    function _pay(string calldata tag, address token, uint256 amount, bytes32 ref, address expectedPayout) private {
        _checkExpectedPayout(expectedPayout);
        Check memory c = _validatePayment(tag, token, amount, msg.sender);
        // Every sum was checked against a uint128 cap, so it fits in uint192.
        _recipientUsage[token][c.recipient] = DayUsage(c.day, uint192(c.recipientUsed + amount));
        _payerUsage[token][msg.sender] = DayUsage(c.day, uint192(c.payerUsed + amount));
        _dailyUsage[token] = DayUsage(c.day, uint192(c.dailyUsed + amount));

        address to = payoutWallet;
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(msg.sender, to, amount);
        uint256 afterwards = IERC20(token).balanceOf(to);
        uint256 received = afterwards > before ? afterwards - before : 0;
        if (received != amount) revert TransferAmountMismatch(amount, received);

        emit TagPaid(c.tagHash, tag, c.recipient, msg.sender, token, amount, ref, c.day);
    }

    /// @dev Every payment rule, in a fixed order. Reverts with the first one broken.
    function _validatePayment(string calldata tag, address token, uint256 amount, address payer)
        private
        view
        returns (Check memory c)
    {
        if (paused) revert Paused();
        c.tagHash = keccak256(bytes(tag));
        TagRecord memory r = _records[c.tagHash];
        if (r.account == address(0) || r.lockedUntil != 0) revert TagNotFound();
        c.recipient = r.account;

        TokenLimits memory l = tokenLimits[token];
        if (l.maxPerPayment == 0) revert TokenNotAllowed(token);
        if (payer == c.recipient) revert SelfPayment();
        _checkCanBePaid(c.recipient);
        if (amount < l.minPerPayment) revert BelowMinimum(amount, l.minPerPayment);
        if (amount > l.maxPerPayment) revert OverPaymentLimit(amount, l.maxPerPayment);

        c.day = uint64(block.timestamp / 1 days);
        c.recipientUsed = _usedOn(_recipientUsage[token][c.recipient], c.day);
        if (c.recipientUsed + amount > l.maxPerRecipientPerDay) {
            revert OverRecipientDailyLimit(amount, _room(l.maxPerRecipientPerDay, c.recipientUsed));
        }
        c.payerUsed = _usedOn(_payerUsage[token][payer], c.day);
        if (c.payerUsed + amount > l.maxPerPayerPerDay) {
            revert OverPayerDailyLimit(amount, _room(l.maxPerPayerPerDay, c.payerUsed));
        }
        c.dailyUsed = _usedOn(_dailyUsage[token], c.day);
        if (c.dailyUsed + amount > l.maxPerDay) revert OverDailyLimit(amount, _room(l.maxPerDay, c.dailyUsed));
    }

    /// @dev Reverts when the payer pinned a payout wallet and it is not the current one.
    function _checkExpectedPayout(address expectedPayout) private view {
        if (expectedPayout != address(0) && expectedPayout != payoutWallet) revert PayoutWalletChanged(payoutWallet);
    }

    /// @dev An address that may hold a tag and be paid: not the payout wallet and not a smart contract.
    function _checkCanBePaid(address account) private view {
        if (account == payoutWallet) revert RecipientIsPayoutWallet();
        if (_isContract(account)) revert RecipientIsContract(account);
    }

    /**
     * @dev True for an address with code, except an EIP-7702 delegated wallet (exactly 23 bytes: 0xef0100 ++ address),
     * which is still an ordinary key-held account. No regular contract can start with 0xef (EIP-3541).
     * An address with no code yet (or a contract under construction) reads as not a contract; `payTag` checks again
     * at payment time, so a contract that claimed from its constructor still can't be paid. Known limit: a contract
     * that claims from its constructor and self-destructs in the same transaction (EIP-6780) leaves a code-less
     * address that holds a tag and can be paid; see docs/WHO-ENFORCES-WHAT.md.
     */
    function _isContract(address account) private view returns (bool) {
        uint256 size = account.code.length;
        if (size == 0) return false;
        if (size != 23) return true;
        uint256 prefix;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            extcodecopy(account, ptr, 0, 3)
            prefix := shr(232, mload(ptr))
        }
        return prefix != 0xef0100;
    }

    /// @dev Releases `holder`'s tag and locks it for everyone else for `RELEASE_LOCK`.
    function _release(address holder, bytes20 current) private {
        string memory tag = _text(current);
        bytes32 tagHash = keccak256(bytes(tag));
        uint256 until = block.timestamp + RELEASE_LOCK;
        TagRecord storage r = _records[tagHash];
        r.lockedUntil = uint40(until);
        delete _tagOf[holder];
        if (bytes(_nameOf[holder]).length != 0) delete _nameOf[holder];
        if (_receiveTokenOf[holder] != address(0)) delete _receiveTokenOf[holder];
        emit TagReleased(tagHash, tag, holder, until);
    }

    function _setTokenLimits(address token, TokenLimits memory l) private {
        if (token.code.length == 0) revert InvalidToken(token);
        bool off = l.minPerPayment == 0 && l.maxPerPayment == 0 && l.maxPerRecipientPerDay == 0
            && l.maxPerPayerPerDay == 0 && l.maxPerDay == 0;
        if (
            !off
                && (
                    l.minPerPayment == 0 || l.minPerPayment > l.maxPerPayment
                        || l.maxPerPayment > l.maxPerRecipientPerDay || l.maxPerRecipientPerDay > l.maxPerDay
                        || l.maxPerPayment > l.maxPerPayerPerDay || l.maxPerPayerPerDay > l.maxPerDay
                )
        ) revert InvalidLimits();
        tokenLimits[token] = l;
        emit TokenLimitsSet(
            token, l.minPerPayment, l.maxPerPayment, l.maxPerRecipientPerDay, l.maxPerPayerPerDay, l.maxPerDay
        );
    }

    function _setPayoutWallet(address wallet) private {
        if (wallet == address(0) || wallet == address(this)) revert InvalidPayoutWallet(wallet);
        emit PayoutWalletSet(payoutWallet, wallet);
        payoutWallet = wallet;
    }

    function _setReserved(string[] memory tags, bool value) private {
        if (tags.length > MAX_RESERVED_BATCH) revert BatchTooLarge(tags.length);
        for (uint256 i; i < tags.length; ++i) {
            bytes32 tagHash = keccak256(bytes(tags[i]));
            if (value) {
                TagRecord memory r = _records[tagHash];
                if (r.account != address(0) && (r.lockedUntil == 0 || r.lockedUntil > block.timestamp)) {
                    revert TagInUse();
                }
            }
            reserved[tagHash] = value;
            emit ReservedSet(tagHash, tags[i], value);
        }
    }

    function _setPaused(bool on) private {
        if (paused == on) revert PauseUnchanged();
        paused = on;
        emit PausedSet(on, msg.sender);
    }

    /// @dev `cap - used`, or 0 when a lowered cap is already used up.
    function _room(uint256 cap, uint256 used) private pure returns (uint256) {
        return used >= cap ? 0 : cap - used;
    }

    /// @dev What `u` says was used on `day` (0 when `u` is about another day).
    function _usedOn(DayUsage memory u, uint256 day) private pure returns (uint256) {
        return u.day == day ? u.used : 0;
    }

    function _isValidTag(bytes calldata b) private pure returns (bool) {
        return LokalText.isValidTag(b, MIN_TAG_LENGTH, MAX_TAG_LENGTH);
    }

    function _isValidName(bytes calldata b) private pure returns (bool) {
        return b.length == 0 || LokalText.isValidText(b, MAX_NAME_BYTES, MAX_NAME_UNITS);
    }

    /// @dev bytes20 (left-aligned, zero-padded) -> string.
    function _text(bytes20 packed) private pure returns (string memory s) {
        uint256 n;
        while (n < 20 && packed[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = packed[i];
        }
        return string(out);
    }
}
