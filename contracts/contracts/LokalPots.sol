// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LokalText} from "./LokalText.sol";

/// @notice The parts of LokalTags that LokalPots reads.
interface ILokalTags {
    function owner() external view returns (address);

    function routeInfo(address recipient, address token)
        external
        view
        returns (address payout, bool isPaused, bool recipientOk, uint256 minPerPayment, uint256 maxPerPayment);
}

/**
 * @title LokalPots
 * @notice One link or QR code, many payers: a wedding where guests "spray" the couple, a birthday, a group kitty.
 * A tag holder opens a pot with a title, a closing time and caps; guests pay small amounts in any allowed token; the
 * money goes straight to the agent's payout wallet, and the agent pays the host in their local currency.
 *
 * The contract has the final say here too. Before any money moves it checks that the pot is open, the host can still
 * be paid, the token is allowed, the amount is within the token's minimum and maximum, and that none of the payer's
 * share, the pot's total, the host's total today or today's total for all pots would pass its cap. It never holds funds.
 *
 * @dev A sibling of LokalTags rather than part of it, so the registry stays small and pots can't touch its storage.
 * Everything shared comes from LokalTags in one `routeInfo` call: the payout wallet, the pause switch, whether the
 * host may be paid, and the token's allow-list entry, minimum and maximum. The admin is whoever owns LokalTags, so one
 * two-step ownership transfer moves both, and one pause switch stops both.
 *
 * Caps are in US dollars with 6 decimals ("usd6"), because one pot takes many tokens at once (USD₮ 6 decimals, IDRX 2,
 * wCOP 18). Each payment is valued with an admin-set rate per token (`unitsPerUsd`: how many base units of the token
 * make one dollar), rounded UP, so rounding can only make a cap bind sooner. Rates are bounded (a token worth between
 * $0.00001 and $2) and one update can move a rate at most 10x, so a typo can't make a large amount look like cents.
 * Pots do not count toward LokalTags' daily limits; they have their own caps, including a per-host daily total and a
 * daily total for all pots together.
 */
contract LokalPots {
    using SafeERC20 for IERC20;

    /// @notice One pot. Dollar amounts are usd6 (6 decimals).
    struct Pot {
        address host;
        uint40 closesAt;
        bool closed;
        uint32 payerCount;
        uint64 capUsd6;
        uint64 perPayerCapUsd6;
        uint64 totalUsd6;
    }

    /// @notice Constructor input: a token's dollar rate.
    struct RateSetup {
        address token;
        uint256 unitsPerUsd;
    }

    /// @notice An amount (usd6) used during one UTC day.
    struct DayUsage {
        uint64 day;
        uint192 used;
    }

    /// @notice Longest a pot may stay open, from creation.
    uint256 public constant MAX_OPEN_TIME = 14 days;
    /// @notice Longest title, in bytes.
    uint256 public constant MAX_TITLE_BYTES = 60;
    /// @notice Largest factor one `setUsdRate` call may move an existing rate by, either way.
    uint256 public constant MAX_RATE_CHANGE = 10;
    /// @notice One US dollar in usd6.
    uint256 private constant USD = 1e6;

    /// @notice The registry: tags, allowed tokens, payout wallet, pause switch and admin.
    ILokalTags public immutable tags;

    /// @notice Largest pot cap a host may choose (usd6).
    uint64 public maxPotCapUsd6;
    /// @notice Largest per-payer cap a host may choose (usd6).
    uint64 public maxPerPayerCapUsd6;
    /// @notice Most one host's pots together may take per UTC day (usd6).
    uint64 public maxPerHostDailyUsd6;
    /// @notice Most all pots together may take per UTC day (usd6).
    uint64 public maxDailyUsd6;
    /// @dev What all pots took on the current UTC day.
    DayUsage private _daily;

    /// @notice Number of pots created. Pot ids run from 1 to `potCount`.
    uint256 public potCount;
    /// @notice token => base units per US dollar (0: pots don't take this token).
    mapping(address token => uint256) public unitsPerUsd;

    mapping(uint256 potId => Pot) private _pots;
    mapping(uint256 potId => string) private _titles;
    mapping(uint256 potId => mapping(address payer => uint256)) private _paidUsd6;
    mapping(uint256 potId => mapping(address token => uint256)) private _tokenTotals;
    mapping(address host => DayUsage) private _hostDaily;

    /// @notice `host` opened pot `potId`.
    event PotCreated(
        uint256 indexed potId,
        address indexed host,
        string title,
        uint256 closesAt,
        uint256 capUsd6,
        uint256 perPayerCapUsd6
    );
    /**
     * @notice `payer` put `amount` of `token` into pot `potId`; the tokens are already in the payout wallet.
     * `totalSoFar` is the pot's total in usd6 including this payment; `amountUsd6` this payment's value.
     */
    event PotPaid(
        uint256 indexed potId,
        address indexed host,
        address indexed payer,
        address token,
        uint256 amount,
        bytes32 ref,
        uint256 totalSoFar,
        uint256 amountUsd6
    );
    /// @notice The host closed pot `potId` with `totalUsd6` from `payerCount` payers.
    event PotClosed(uint256 indexed potId, address indexed host, uint256 totalUsd6, uint256 payerCount);
    /// @notice `token` is now valued at `unitsPerUsd` base units per dollar (0: no longer taken by pots).
    event UsdRateSet(address indexed token, uint256 unitsPerUsd);
    /// @notice New maxima for pots (usd6).
    event PotLimitsSet(
        uint256 maxPotCapUsd6, uint256 maxPerPayerCapUsd6, uint256 maxPerHostDailyUsd6, uint256 maxDailyUsd6
    );
    /// @notice `amount` of `token` that was sent to this contract by mistake was returned to `to`.
    event Rescued(address indexed token, address indexed to, uint256 amount);

    /// @notice LokalTags is paused.
    error Paused();
    /// @notice The host doesn't hold a tag, is a smart contract, or is the payout wallet.
    error HostNotEligible(address host);
    /// @notice The title is empty, over 60 bytes, not valid UTF-8, or has a control, invisible or edge-space character.
    error InvalidTitle();
    /// @notice `closesAt` must be in the future and at most 14 days away.
    error InvalidCloseTime(uint256 closesAt, uint256 latest);
    /// @notice Caps must satisfy 0 < perPayerCap <= potCap, within the admin's maxima.
    error InvalidPotCaps();
    /// @notice No pot has this id.
    error PotNotFound(uint256 potId);
    /// @notice The host closed this pot.
    error PotIsClosed(uint256 potId);
    /// @notice This pot's closing time has passed.
    error PotExpired(uint256 potId, uint256 closedAt);
    /// @notice Only the pot's host can do this.
    error NotHost();
    /// @notice The host can't pay into their own pot.
    error SelfPayment();
    /// @notice The token is not allowed in LokalTags, or has no dollar rate here.
    error TokenNotAllowed(address token);
    /// @notice The amount is under the token's minimum per payment (from LokalTags).
    error BelowMinimum(uint256 amount, uint256 minimum);
    /// @notice The amount is over the token's maximum per payment (from LokalTags).
    error OverPaymentLimit(uint256 amount, uint256 maximum);
    /// @notice This payer's total in this pot would pass the per-payer cap.
    error OverPayerCap(uint256 amountUsd6, uint256 remainingUsd6);
    /// @notice The pot's total would pass its cap.
    error PotFull(uint256 amountUsd6, uint256 remainingUsd6);
    /// @notice The host's pots together would take more than the per-host daily maximum today.
    error OverHostDailyLimit(uint256 amountUsd6, uint256 remainingUsd6);
    /// @notice All pots together would take more than the daily maximum today.
    error OverDailyLimit(uint256 amountUsd6, uint256 remainingUsd6);
    /// @notice The payout wallet did not receive exactly `expected`.
    error TransferAmountMismatch(uint256 expected, uint256 received);
    /// @notice The payout wallet is not the one the payer expected (it was changed).
    error PayoutWalletChanged(address current);
    /// @notice Only the owner of LokalTags can do this.
    error NotAdmin(address account);
    /// @notice Maxima must satisfy 0 < perPayer <= potCap <= perHostDaily <= daily.
    error InvalidLimits();
    /// @notice The address has no code, or (for a rate) reports no decimals.
    error InvalidToken(address token);
    /// @notice The rate is outside [10^decimals / 2, 10^decimals * 100000], or moves more than 10x from the current one.
    error RateOutOfBounds(uint256 rate, uint256 lowest, uint256 highest);
    /// @notice A rescue can't go to the zero address or this contract.
    error InvalidRecipient(address to);

    /// @dev The owner of LokalTags.
    modifier onlyAdmin() {
        if (msg.sender != tags.owner()) revert NotAdmin(msg.sender);
        _;
    }

    /**
     * @param tags_ The LokalTags registry.
     * @param maxPotCapUsd6_ Largest pot cap (default $100).
     * @param maxPerPayerCapUsd6_ Largest per-payer cap (default $5).
     * @param maxPerHostDailyUsd6_ Most one host's pots may take per UTC day (default $100).
     * @param maxDailyUsd6_ Most all pots together may take per UTC day (default $250).
     * @param rates Dollar rates for the tokens pots take.
     */
    constructor(
        ILokalTags tags_,
        uint64 maxPotCapUsd6_,
        uint64 maxPerPayerCapUsd6_,
        uint64 maxPerHostDailyUsd6_,
        uint64 maxDailyUsd6_,
        RateSetup[] memory rates
    ) {
        if (address(tags_).code.length == 0) revert InvalidToken(address(tags_));
        tags = tags_;
        _setLimits(maxPotCapUsd6_, maxPerPayerCapUsd6_, maxPerHostDailyUsd6_, maxDailyUsd6_);
        for (uint256 i; i < rates.length; ++i) {
            _setUsdRate(rates[i].token, rates[i].unitsPerUsd);
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Hosts and payers
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Opens a pot. The caller is the host and must hold a tag; the agent pays the host's wallet.
     * @param title What the pot is for, 1-60 bytes, e.g. "Ada & Tunde's wedding".
     * @param closesAt When it stops taking payments (unix seconds, at most 14 days from now).
     * @param potCapUsd6 Most the pot may take in total, in dollars with 6 decimals.
     * @param perPayerCapUsd6 Most one payer may put in, in dollars with 6 decimals.
     * @return potId The new pot's id.
     */
    function createPot(string calldata title, uint64 closesAt, uint256 potCapUsd6, uint256 perPayerCapUsd6)
        external
        returns (uint256 potId)
    {
        (, bool isPaused, bool hostOk,,) = tags.routeInfo(msg.sender, address(0));
        if (isPaused) revert Paused();
        if (!hostOk) revert HostNotEligible(msg.sender);
        if (!LokalText.isValidText(bytes(title), MAX_TITLE_BYTES, MAX_TITLE_BYTES)) revert InvalidTitle();
        uint256 latest = block.timestamp + MAX_OPEN_TIME;
        if (closesAt <= block.timestamp || closesAt > latest) revert InvalidCloseTime(closesAt, latest);
        if (
            perPayerCapUsd6 == 0 || perPayerCapUsd6 > potCapUsd6 || potCapUsd6 > maxPotCapUsd6
                || perPayerCapUsd6 > maxPerPayerCapUsd6
        ) revert InvalidPotCaps();

        potId = ++potCount;
        _pots[potId] = Pot({
            host: msg.sender,
            closesAt: uint40(closesAt),
            closed: false,
            payerCount: 0,
            capUsd6: uint64(potCapUsd6),
            perPayerCapUsd6: uint64(perPayerCapUsd6),
            totalUsd6: 0
        });
        _titles[potId] = title;
        emit PotCreated(potId, msg.sender, title, closesAt, potCapUsd6, perPayerCapUsd6);
    }

    /**
     * @notice Pays `amount` of `token` into pot `potId`. Every cap is checked first; then the tokens go straight from
     * the caller to the payout wallet (approve this contract first). Nothing stays here.
     * @param potId The pot.
     * @param token An allowed token with a dollar rate.
     * @param amount Amount in the token's own units.
     * @param ref The payer's own reference, echoed in `PotPaid`.
     * @param expectedPayout The payout wallet the payer expects, or zero to skip the check.
     */
    function payPot(uint256 potId, address token, uint256 amount, bytes32 ref, address expectedPayout) external {
        Check memory c = _validate(potId, token, amount, msg.sender);
        if (expectedPayout != address(0) && expectedPayout != c.payout) revert PayoutWalletChanged(c.payout);
        uint256 total = c.pot.totalUsd6 + c.usd6;

        // Effects. Every sum was checked against a uint64 cap.
        Pot storage s = _pots[potId];
        s.totalUsd6 = uint64(total);
        if (c.paidBefore == 0) s.payerCount = c.pot.payerCount + 1;
        _paidUsd6[potId][msg.sender] = c.paidBefore + c.usd6;
        _tokenTotals[potId][token] += amount;
        _hostDaily[c.pot.host] = DayUsage(c.day, uint192(c.hostUsed + c.usd6));
        _daily = DayUsage(c.day, uint192(c.dayUsed + c.usd6));

        // One transfer, payer -> payout wallet, and check exactly `amount` arrived.
        uint256 before = IERC20(token).balanceOf(c.payout);
        IERC20(token).safeTransferFrom(msg.sender, c.payout, amount);
        uint256 afterwards = IERC20(token).balanceOf(c.payout);
        uint256 received = afterwards > before ? afterwards - before : 0;
        if (received != amount) revert TransferAmountMismatch(amount, received);

        emit PotPaid(potId, c.pot.host, msg.sender, token, amount, ref, total, c.usd6);
    }

    /// @notice Stops a pot taking payments. Host only; works while paused and after the closing time.
    function closePot(uint256 potId) external {
        Pot storage s = _pots[potId];
        if (s.host == address(0)) revert PotNotFound(potId);
        if (s.host != msg.sender) revert NotHost();
        if (s.closed) revert PotIsClosed(potId);
        s.closed = true;
        emit PotClosed(potId, msg.sender, s.totalUsd6, s.payerCount);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Admin (the owner of LokalTags)
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Sets how many base units of `token` make one US dollar (0 stops pots taking it). Re-tune as rates move.
     * Must lie in [10^decimals / 2, 10^decimals * 100000] and, when a rate is already set, within 10x of it.
     * @param token The token.
     * @param unitsPerUsd_ E.g. 1e6 for USD₮, 1441e6 for cNGN at ₦1,441/$, 18407e2 for IDRX.
     */
    function setUsdRate(address token, uint256 unitsPerUsd_) external onlyAdmin {
        _setUsdRate(token, unitsPerUsd_);
    }

    /**
     * @notice Sets the maxima hosts can choose and the daily totals. Existing pots keep their caps.
     * @param maxPotCapUsd6_ Largest pot cap.
     * @param maxPerPayerCapUsd6_ Largest per-payer cap.
     * @param maxPerHostDailyUsd6_ Most one host's pots may take per UTC day (lowering it applies at once).
     * @param maxDailyUsd6_ Most all pots together may take per UTC day (lowering it applies at once).
     */
    function setLimits(
        uint64 maxPotCapUsd6_,
        uint64 maxPerPayerCapUsd6_,
        uint64 maxPerHostDailyUsd6_,
        uint64 maxDailyUsd6_
    ) external onlyAdmin {
        _setLimits(maxPotCapUsd6_, maxPerPayerCapUsd6_, maxPerHostDailyUsd6_, maxDailyUsd6_);
    }

    /**
     * @notice Returns tokens that were sent to this contract by mistake. Nothing is ever held here legitimately.
     * @param token The token.
     * @param to Where to send it.
     * @param amount How much.
     */
    function rescue(address token, address to, uint256 amount) external onlyAdmin {
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @notice Everything a pot page needs.
     * @return host The host.
     * @return title The title.
     * @return closesAt Closing time.
     * @return open True while it takes payments (not closed, not past `closesAt`).
     * @return capUsd6 Pot cap.
     * @return perPayerCapUsd6 Per-payer cap.
     * @return totalUsd6 Paid in so far.
     * @return payerCount Distinct payers so far.
     */
    function potInfo(uint256 potId)
        external
        view
        returns (
            address host,
            string memory title,
            uint256 closesAt,
            bool open,
            uint256 capUsd6,
            uint256 perPayerCapUsd6,
            uint256 totalUsd6,
            uint256 payerCount
        )
    {
        Pot memory p = _pots[potId];
        if (p.host == address(0)) revert PotNotFound(potId);
        return (
            p.host,
            _titles[potId],
            p.closesAt,
            !p.closed && block.timestamp < p.closesAt,
            p.capUsd6,
            p.perPayerCapUsd6,
            p.totalUsd6,
            p.payerCount
        );
    }

    /// @notice What `payer` has put into pot `potId` (usd6).
    function paidBy(uint256 potId, address payer) external view returns (uint256) {
        return _paidUsd6[potId][payer];
    }

    /// @notice How much of `token` pot `potId` took, in the token's units.
    function tokenTotal(uint256 potId, address token) external view returns (uint256) {
        return _tokenTotals[potId][token];
    }

    /**
     * @notice Room left (usd6) for `payer` in pot `potId`. A payment fits when its dollar value is at most the smallest
     * of the four.
     * @return forPayer Left under the per-payer cap.
     * @return forPot Left under the pot cap.
     * @return forHost Left under the host's daily total.
     * @return forToday Left under today's total for all pots.
     */
    function remaining(uint256 potId, address payer)
        external
        view
        returns (uint256 forPayer, uint256 forPot, uint256 forHost, uint256 forToday)
    {
        Pot memory p = _pots[potId];
        uint64 day = uint64(block.timestamp / 1 days);
        forPayer = _room(p.perPayerCapUsd6, _paidUsd6[potId][payer]);
        forPot = _room(p.capUsd6, p.totalUsd6);
        forHost = _room(maxPerHostDailyUsd6, _usedOn(_hostDaily[p.host], day));
        forToday = _room(maxDailyUsd6, _usedOn(_daily, day));
    }

    /// @notice The dollar value (usd6, rounded up) pots give `amount` of `token`; 0 when pots don't take it.
    function usdValue(address token, uint256 amount) public view returns (uint256) {
        uint256 rate = unitsPerUsd[token];
        return rate == 0 ? 0 : Math.mulDiv(amount, USD, rate, Math.Rounding.Ceil);
    }

    /**
     * @notice Dry run of `payPot` for `payer`: reverts with exactly the error it would hit (except balance and
     * allowance), else returns the payment's dollar value.
     */
    function validatePotPayment(uint256 potId, address token, uint256 amount, address payer)
        external
        view
        returns (uint256 amountUsd6)
    {
        return _validate(potId, token, amount, payer).usd6;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev The result of a successful pot payment check.
    struct Check {
        Pot pot;
        address payout;
        uint256 usd6;
        uint256 paidBefore;
        uint64 day;
        uint256 hostUsed;
        uint256 dayUsed;
    }

    /// @dev Every pot payment rule, in a fixed order. Reverts with the first one broken.
    function _validate(uint256 potId, address token, uint256 amount, address payer)
        private
        view
        returns (Check memory c)
    {
        Pot memory p = _pots[potId];
        if (p.host == address(0)) revert PotNotFound(potId);
        bool isPaused;
        bool hostOk;
        uint256 minimum;
        uint256 maximum;
        (c.payout, isPaused, hostOk, minimum, maximum) = tags.routeInfo(p.host, token);
        if (isPaused) revert Paused();
        if (p.closed) revert PotIsClosed(potId);
        if (block.timestamp >= p.closesAt) revert PotExpired(potId, p.closesAt);
        if (payer == p.host) revert SelfPayment();
        if (!hostOk) revert HostNotEligible(p.host);
        if (maximum == 0 || unitsPerUsd[token] == 0) revert TokenNotAllowed(token);
        if (amount < minimum) revert BelowMinimum(amount, minimum);
        if (amount > maximum) revert OverPaymentLimit(amount, maximum);

        c.pot = p;
        c.usd6 = usdValue(token, amount);
        c.paidBefore = _paidUsd6[potId][payer];
        uint256 room = _room(p.perPayerCapUsd6, c.paidBefore);
        if (c.usd6 > room) revert OverPayerCap(c.usd6, room);
        room = _room(p.capUsd6, p.totalUsd6);
        if (c.usd6 > room) revert PotFull(c.usd6, room);
        c.day = uint64(block.timestamp / 1 days);
        c.hostUsed = _usedOn(_hostDaily[p.host], c.day);
        room = _room(maxPerHostDailyUsd6, c.hostUsed);
        if (c.usd6 > room) revert OverHostDailyLimit(c.usd6, room);
        c.dayUsed = _usedOn(_daily, c.day);
        room = _room(maxDailyUsd6, c.dayUsed);
        if (c.usd6 > room) revert OverDailyLimit(c.usd6, room);
    }

    function _usedOn(DayUsage memory u, uint256 day) private pure returns (uint256) {
        return u.day == day ? u.used : 0;
    }

    function _room(uint256 cap, uint256 used) private pure returns (uint256) {
        return used >= cap ? 0 : cap - used;
    }

    function _setUsdRate(address token, uint256 rate) private {
        if (token.code.length == 0) revert InvalidToken(token);
        if (rate != 0) {
            uint8 decimals;
            try IERC20Metadata(token).decimals() returns (uint8 d) {
                decimals = d;
            } catch {
                revert InvalidToken(token);
            }
            uint256 one = 10 ** uint256(decimals);
            uint256 lowest = one / 2;
            uint256 highest = one * 100_000;
            uint256 current = unitsPerUsd[token];
            if (current != 0) {
                lowest = Math.max(lowest, current / MAX_RATE_CHANGE);
                highest = Math.min(highest, current * MAX_RATE_CHANGE);
            }
            if (rate < lowest || rate > highest) revert RateOutOfBounds(rate, lowest, highest);
        }
        unitsPerUsd[token] = rate;
        emit UsdRateSet(token, rate);
    }

    function _setLimits(uint64 potCap, uint64 perPayer, uint64 perHostDaily, uint64 daily) private {
        if (perPayer == 0 || perPayer > potCap || potCap > perHostDaily || perHostDaily > daily) revert InvalidLimits();
        maxPotCapUsd6 = potCap;
        maxPerPayerCapUsd6 = perPayer;
        maxPerHostDailyUsd6 = perHostDaily;
        maxDailyUsd6 = daily;
        emit PotLimitsSet(potCap, perPayer, perHostDaily, daily);
    }
}
