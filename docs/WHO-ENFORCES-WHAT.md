# Who enforces what

Lokal's claim is that **the agent decides, and the contract has the final say**. That is true for the rules that can
be checked before money moves: tags, and the limits on every payment to a tag or a pot. It is not true for everything
the product does. The swap into the recipient's local currency and the payout from the agent's wallet happen off the
contracts, in the agent's code. This page says which is which.

Everything here is read from the code: `contracts/contracts/LokalTags.sol` (tags and payments to a tag),
`contracts/contracts/LokalPots.sol` (pots: one link, many payers), `contracts/contracts/LokalText.sol` (the text
rules both share), `src/guards.mjs`, `src/pay.mjs`, `src/watch.mjs` and `src/ntags.mjs` (the agent), and
`site/assets/core.js` (the site). The rules are exercised by `contracts/tests/` (`npm test` in `contracts/`, including
the independent audit's attack scenarios in `tests/Attack.spec.ts`) and by `npm run demo`, which walks the whole story
and asserts every outcome.

> **Status.** `LokalTags` ([`0xFF2f8ADC0c97B6E40b201848d378C11325bC7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187)) and `LokalPots` ([`0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF`](https://celoscan.io/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF)) are live on Celo
> mainnet and source-verified. **The site, the `lokal` command and autopilot have switched to them** (built and
> tested, not yet used on mainnet): tags are claimed, renamed and released on LokalTags, payments go through `payTag` /
> `payTagWithPermit`, and autopilot pays the `TagPaid` / `PotPaid` events. From the cutover block (83,405,000) legacy
> `NT1:` claims are ignored; `NTP:` memo payments to tags claimed the old way before it are still paid, under the
> agent's offchain rules. The payer's currency choice travels in the payment's `ref` (`cur:<code>`).

## Enforced by LokalTags (onchain, before any money moves)

| Rule | Contract check | Notes |
| --- | --- | --- |
| Tag format: `^[a-z][a-z0-9_]{2,19}$`, no `__`, not ending in `_` | `claim` reverts `InvalidTag` | Same rule as the site's `ntagError`. A test compares the contract with the site's live code on 3,000 random tags. |
| Reserved tags | `claim` reverts `TagReserved` | The 63 names in the shared list of `site/assets/core.js` and `src/ntags.mjs`: system words (agent, admin, support, ...), brands (celo, minipay, textile, naira, lokal, lokalpay, ...) and lookalikes (lokal_support, helpdesk, admin1, celo_team, minipay_support, textile_fx, ...). Seeded in the constructor, so none can be claimed after deployment. The deploy script refuses to deploy if its list differs from either live file by a single name. Exact-match only: a tag like `supp0rt` is not caught (see "Known, accepted behaviour"). |
| Display name: at most 40 characters, no control, invisible or text-direction characters, trimmed | `claim` / `setName` revert `InvalidName` | Characters are counted like JavaScript's `length` (UTF-16 units), so an accented Yoruba name the site accepts is accepted here too. Must be valid UTF-8. Refused anywhere in the name: U+0000-U+001F, U+007F-U+009F, U+200B-U+200F (zero-width characters, LRM/RLM), U+202A-U+202E (bidi embeddings and overrides), U+2060-U+2069 (word joiner, bidi isolates) and U+FEFF. No whitespace at either end (JavaScript `trim()` rules). The site's `ntagNameError` refuses exactly the same set. |
| First claim wins | `TagTaken(owner)` | The chain orders the claims. |
| One tag per wallet | claiming a second tag releases the first in the same transaction | `TagReleased` then `TagClaimed`. |
| 30-day release lock | `TagLocked(until)` for everyone but the previous owner | Ends exactly 30 days after the release (`block.timestamp` >= until). |
| Who gets paid | `payTag` reads the holder at the moment of payment and puts it in `TagPaid.recipient` | The agent no longer has to replay the claim history. |
| Only allowed tokens | `TokenNotAllowed` | USD₮, cNGN, IDRX, wARS and wCOP at deploy. Any number of tokens, any decimals. |
| Minimum per payment | `BelowMinimum(amount, min)` | Per token, in its own units (about $1). |
| Maximum per payment | `OverPaymentLimit(amount, max)` | $25 for USD₮; about $24.25 for local tokens (3% under $25, the agent's slippage margin). |
| Maximum per **recipient** per UTC day | `OverRecipientDailyLimit(amount, remaining)` | Per token, about $25, counted per **wallet**, so switching tags does not reset it. Day = `block.timestamp / 1 days`. |
| Maximum per **payer** per UTC day | `OverPayerDailyLimit(amount, remaining)` | Per token, about $25. One wallet can't spread more than that over many tags. |
| Maximum overall per UTC day | `OverDailyLimit(amount, remaining)` | Per token: $250 for USD₮, about $242.50 for each local token. With $25 per payer and per recipient, using up a token's day takes **at least 10 different paying wallets and 10 different recipients**. |
| No paying yourself | `SelfPayment` | Payer is the tag's holder. |
| No smart-contract recipients | `RecipientIsContract(account)` at claim and again at payment | EIP-7702 delegated wallets count as wallets (tested with a real type-4 transaction on the Prague hardfork). A contract that claimed from its constructor (no code yet) is caught at payment time. See "Known, accepted behaviour" for the one gap. |
| The payout wallet can't be a recipient | `RecipientIsPayoutWallet` | |
| The payer can pin where the money goes | `payTag(..., expectedPayout)` reverts `PayoutWalletChanged(current)` if the payout wallet is not the one the payer expected | Zero skips the check. The site passes the payout wallet it shows. |
| Exactly the amount arrives | `TransferAmountMismatch` | The payout wallet's balance must rise by exactly `amount`: fee-on-transfer, lying (`true` but no transfer) and re-entrant tokens are all refused. `false`-returning tokens revert in SafeERC20. |
| The contract never holds money | `payTag` does one `transferFrom(payer, payoutWallet, amount)` | Tests assert a zero balance after every payment. |
| Pause | `Paused` on claims, renames, receive-token changes and payments (tags and pots) | Releasing a tag and closing a pot always work, even while paused. |
| A new payout wallet waits 24 hours | `proposePayoutWallet` → `executePayoutWallet` (after 24 h, else `PayoutWalletNotReady`) or `cancelPayoutWallet` | `PayoutWalletProposed`, `PayoutWalletSet`, `PayoutWalletCancelled`. Anyone watching has a day to notice; payments signed with `expectedPayout` can't be redirected at all. |
| Admin changes are visible | `TokenLimitsSet`, `PayoutWallet*`, `ReservedSet`, `PausedSet`, `Rescued`, `OwnershipTransfer*` | Every admin call emits an event. |
| The admin can't take a tag or anyone's tokens | there is no such function | `setReserved` refuses a tag that is held or inside its lock (`TagInUse`). `rescue(token, to, amount)` only sends tokens **the contract itself** holds, which only happens when someone sends tokens to it by mistake. It can't reach a payer's balance or allowance. A test checks the full list of state-changing functions. |
| No upgrades, no renounce | no proxy; `renounceOwnership` reverts `RenounceDisabled` | Ownership moves only in two steps (`transferOwnership` + `acceptOwnership`). |

## Enforced by LokalPots (onchain, before any money moves)

A pot is one link or QR code that many people pay into: guests "spraying" at a wedding, a birthday, a group kitty.
`LokalPots` is a separate contract that reads `LokalTags` for the payout wallet, the pause switch, whether the host
can be paid, and each token's allow-list entry, minimum and maximum (one `routeInfo` call). Its admin is whoever owns
`LokalTags`, so there is one owner and one pause switch for both.

| Rule | Contract check | Notes |
| --- | --- | --- |
| Only a tag holder can open a pot | `createPot` reverts `HostNotEligible(host)` | Same recipient rules as a tag: not a smart contract, not the payout wallet. Checked again at every payment, so a host who gives up their tag stops receiving. |
| Title: 1-60 bytes, same text rules as names | `InvalidTitle` | No control, invisible or text-direction characters, trimmed (`LokalText`). |
| Closes within 14 days | `InvalidCloseTime(closesAt, latest)` | Payments are refused from the closing second on: `PotExpired`. |
| Caps chosen by the host, inside the admin's maxima | `InvalidPotCaps` | 0 < per payer <= pot cap; pot cap <= $100 and per payer <= $5 by default. |
| Per-payer cap, cumulative per pot | `OverPayerCap(amountUsd6, remaining)` | Counts every token the payer used in that pot. |
| Pot cap, cumulative | `PotFull(amountUsd6, remaining)` | |
| Per **host** per UTC day | `OverHostDailyLimit(amountUsd6, remaining)` | $100 by default, across all of one host's pots. |
| All pots together per UTC day | `OverDailyLimit(amountUsd6, remaining)` | $250 by default. Draining it takes at least 3 hosts and 50 paying wallets; one host with many sybil payers stops at $100. |
| Token allowed, within its minimum and maximum | `TokenNotAllowed`, `BelowMinimum`, `OverPaymentLimit` | From `LokalTags`; the token also needs a dollar rate in `LokalPots`. The maximum means a mistyped rate can never let a huge amount through as "cents". |
| Dollar rates are sane | `setUsdRate` reverts `RateOutOfBounds(rate, lowest, highest)` | A rate must lie in `[10^decimals / 2, 10^decimals x 100,000]` (a token worth between $2 and $0.00001), and one update can move it at most 10x either way. The auditor's typo (an 18-decimal rate for 6-decimal cNGN) is refused. |
| Host can't pay their own pot | `SelfPayment` | |
| The payer can pin where the money goes | `payPot(..., expectedPayout)` reverts `PayoutWalletChanged` | Same as `payTag`. |
| Open only | `PotIsClosed` after the host's `closePot`, `PotExpired` after `closesAt` | |
| Exactly the amount arrives, nothing stays | one `transferFrom(payer, payoutWallet, amount)` and a balance check (`TransferAmountMismatch`) | Re-entry from a token hook sees the outer payment's usage (checks, then effects, then the transfer) and is tested. |
| Stray tokens | `rescue(token, to, amount)` (admin) | Same as `LokalTags`. |

**How pot caps are counted.** One pot takes many tokens with different decimals (USD₮ 6, IDRX 2, wCOP 18), so its caps
are in US dollars (6 decimals). Each payment is valued with an admin-set rate per token (`unitsPerUsd`, for example
1,441 cNGN = $1), **rounded up**, so rounding can only make a cap bind sooner. The rates are fixed numbers, not a price
feed: the admin re-tunes them with `setUsdRate` as currencies move, within the bounds above. (Separate caps per token
would let one guest put $5 in each of five tokens, so a dollar cap is the safer and simpler rule.)

**Pots have their own caps.** A pot payment does **not** count toward `LokalTags`' per-recipient, per-payer or per-token
daily limits, and a tag payment does not count toward a pot. A host can therefore receive both their pots (up to $100
a day) and up to about $25 a day per token by tag.

**What this fixes.** Today a payment over a limit, to an unknown tag or to yourself is refused by the agent *after*
the money reached its wallet, and the money sits there until the operator pays it out or back by hand. With the
contracts, such a payment never happens: the payer's wallet shows the revert reason before anything is signed (or
`validatePayment` / `validatePotPayment` explains it with a free `eth_call`), and nothing moves. And because claims and
payments are ordinary contract calls, wallets no longer show "data sent to a plain address" or "unusual trailing
calldata" warnings.

## The contract's caps are the outer bound (as built)

**Decision, as built (21 Nov 2026):** the agent's own caps **still apply** to contract payments. Since refunds shipped,
a contract payment the agent refuses is no longer stuck: it is recorded as refused and refundable to the payer the
event names (`refund --deposit <inner Transfer>`, or `--auto-refund`). So the contract is the outer bound and the agent
may be stricter (per payout, per wallet per 24 hours, the rolling daily total, slippage). The earlier plan below is
kept for the record.

### Earlier plan (superseded)

For deposits that arrive through `LokalTags` or `LokalPots` (a `TagPaid` or `PotPaid` event), **the agent must treat
the contract's caps as final**. It must not apply any extra offchain daily cap (per wallet, per payer, or its rolling
24-hour overall cap) that could refuse a payment the contract already accepted: that would recreate the stuck-funds
problem the contracts exist to remove. For these deposits the agent keeps only:

- its **per-payout** check (one payout at most $25, valued with a live quote), and
- its **slippage** check (firm quote at most 3% worse than the preview).

If one of those two fails (for example a local currency moved more than 3% before the admin re-tuned the limits), the
agent pauses that payout and the operator decides; it never silently keeps the money. Deposits that do not come
through the contracts (direct transfers, old `NTP:` memos during the migration) keep today's full offchain rules.
This change to `src/` happens in the next phase.

## Enforced by the agent (offchain, in `src/`)

| Rule | Where | What the contracts do instead |
| --- | --- | --- |
| The swap into the recipient's currency (Textile FX quote, approval, swap) | `src/pay.mjs`, `src/textile.mjs` | Nothing. The contracts only deliver the deposit to the payout wallet. |
| Firm quote at most 3% worse than the preview (slippage) | `src/guards.mjs` (`MAX_SLIPPAGE_BPS` = 300) | Nothing. The 3% margin on local-token caps exists so a deposit the contract accepts still fits the agent's per-payout cap after a small move. |
| At most $25 per payout | `src/guards.mjs`, `src/pay.mjs` | The contract's per-payment maximum is the same number in each token's units. |
| The payout to the recipient (measured balance change, capped at what the swap delivered) | `src/pay.mjs` | Nothing. The contract names the recipient in `TagPaid`; the agent pays them. |
| Paying out a pot to its host (when, and in which currency) | the agent, from `PotPaid` events (`host` is in every event) | `LokalPots` only checks the caps and forwards each payment. Whether the agent pays the host per payment or once at `PotClosed` is the agent's choice. |
| Which currency to pay out | corridor by deposit token; `receiveTokenOf(holder)` is a preference the agent may read | `setReceiveToken` only records the holder's wish (an allowed token or none). |
| Daily caps for deposits that do **not** come through the contracts ($25 per wallet and $100 overall per rolling 24 h) | `src/guards.mjs`, `src/pay.mjs` | For contract deposits, the contract's caps replace these (see above). |
| Valuing local tokens in dollars | live Textile quote at payout time | No price feed onchain: limits and pot rates are fixed numbers set by the admin, re-tuned as rates move. |
| Blocked recipients (the agent, the operator's own wallets, token and registry contracts, the zero address) | `src/guards.mjs`, `src/pay.mjs` | Partly: contracts and the payout wallet can't be recipients. The operator's other wallets are only blocked by the agent. |
| Each deposit is paid once (recorded before paying) | `src/watch.mjs` | Nothing. The contract emits one event per payment; exactly-once payout is the agent's job. |
| Attribution tag `celo_7360953d1b53` on every agent transaction | `src/chain.mjs` (`withAttribution`) | Nothing. (The deploy script appends the same ERC-8021 suffix to every deployment transaction.) |
| Receipts (`NP-XXXX-XXXX`, `receipts.jsonl`, the status server) | `src/pay.mjs`, `src/status-report.mjs`, `api/status.js` | Nothing. `TagPaid` / `PotPaid` are the onchain records a receipt can point to. |

## Shown by the site only (a convenience, never the guard)

| What | Where | Why it is safe |
| --- | --- | --- |
| Live availability as you type, suggestions, the tag card preview | `site/account.html` | The contract re-checks everything in `claim`. With the contract, the site reads `availability(tag, you)` directly. |
| "How much more can they receive today" | `site/tag.html` | `remainingToday(token, recipient, payer)` is the authoritative number; the contract refuses anything above it. |
| Input normalisation (trim, strip `@`, lowercase) | `normalizeNtag` | The contract only accepts the normalised form, so a sloppy client gets `InvalidTag`, never a different tag. |
| Balance and network checks before asking for a signature | `site/js/pay.js`, `site/assets/session.js` | A payer without balance or allowance moves nothing: the token's `transferFrom` reverts. |

## If something is wrong, tricked or compromised

**The agent's code is wrong or tricked** (bad tag resolution, a spoofed memo, a confused autopilot):
- *Can't* make a payer send more than the limits, to an unknown tag, to themselves or to a contract: the contracts
  refuse those before the money moves.
- *Can't* misjudge who a payment is for: the recipient or host is in the event the contract emitted.
- *Can* still pay the wrong person or the wrong amount **from its own wallet** when it does the swap and payout, or
  not pay at all. The contracts do not control the agent's outgoing payouts; the agent's own guards do.

**The agent key is stolen.** The deploy script hands the admin role to the owner's separate wallet
(`ADMIN_WALLET`, 0xc2808B63906F48C1BaCaa1E2Ad2e1Cb2A363A070, by default) right after deployment, and refuses to leave
the agent's hot key as admin unless told to with `ALLOW_SAME_OWNER=1`. So a stolen agent key controls only the payout
wallet's existing balance. It can't change the payout wallet, limits, rates or the reserved list, or pause.

**The admin key is stolen or careless.** Whoever holds it can:
- propose a new payout wallet, which takes effect only after **24 hours** in public (`PayoutWalletProposed`), so the
  owner can see it and pause. Payments signed with `expectedPayout` revert rather than follow the change;
- raise limits and pot maxima, move pot rates (at most 10x per update, within the bounds), allow tokens, edit the
  reserved list (but not reserve a tag someone holds), pause, and rescue tokens stuck in the contracts.
- They *can't* take a tag from its owner, close or edit someone's pot, move tokens already paid, or touch payers'
  balances beyond what each payer sends in a payment they sign themselves.

**The website is compromised.** It could show a wrong contract address or ask for a bad transaction. The wallet shows
the contract call being signed, and the contracts still apply every rule above. Check the contract addresses against
the ones in the README and [CONTRACTS.md](CONTRACTS.md).

## Known, accepted behaviour

These are by design or low impact. Each has a test that pins today's behaviour.

- **Claim from a constructor, then self-destruct (low impact).** A contract that claims a tag from its constructor and
  self-destructs in the same transaction (EIP-6780) leaves an address with no code that holds a tag. It passes the
  contract-recipient check and can be paid. The money still goes to the agent's payout wallet. The agent would then
  pay an address that only the same CREATE2 deployer can ever control again, so only the payer's own payment is at
  risk, and nobody else's funds. A cheap fix (`tx.origin == msg.sender` on claims) would break sponsored EIP-7702
  wallets, so it is not used. Mitigations: the agent may refuse payouts to addresses whose claim transaction created
  contracts, and the site shows the holder's address.
- **Lookalike tags.** The reserved list is exact-match. The likely lookalikes are reserved, but variants such as
  `supp0rt` or `lokal_supp0rt` are not. The admin can add more with `setReserved` (never for a tag someone holds).
  Display names can't hide text with invisible or direction characters, but they are still free text chosen by the
  holder.
- **Several wallets, several tags.** The per-recipient cap is per wallet. Someone with N wallets (N tags) can be paid
  N x the cap, and anyone can be paid about $25 a day in **each** allowed token, plus pots. The overall per-token daily
  caps, the per-host pot cap and the agent's per-payout check bound the total.
- **Permit replaces an allowance.** `payTagWithPermit` sets the router's allowance to exactly the payment amount and
  uses it up, so an earlier unlimited approval to the router is gone afterwards. This is benign: the payer approves
  again or uses permit again.
- **Limits change at once.** Lowering or raising a limit applies immediately to today's usage. A token switched off
  and on again within a day keeps that day's usage.
- **Per-token, not per-dollar, tag limits.** `LokalTags`' limits are per token in that token's units. Only pots use
  dollar rates.

## What the contracts do not know

- Whether a display name or pot title is truthful. They are public, permanent claims by the holder.
- Exchange rates. Limits are per token, in that token's units; pot rates are admin-set numbers.
- Whether the agent actually paid out. That is in the agent's receipts and the payout transactions from its wallet.
- Anything about the old `NT1:` / `NTP:` history. Tags claimed under the old protocol need to be claimed again on the
  contract; there is no admin import, on purpose. Until then the agent keeps paying `NTP:` memo payments to them, and
  when a name is held in both places the contract's holder wins (see [Lokal tag rules](PROTOCOL.md#lokal-tag-rules)).
