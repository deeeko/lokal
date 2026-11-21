# Contracts: LokalTags and LokalPots

## The contract has the final say

**The agent decides; the contract has the final say.** Two Solidity contracts check the rules *before* any money moves,
so a payment that breaks a limit is refused by Celo itself instead of being refunded later:

- **`LokalTags`**: the Lokal tag registry and payment router. Claim a tag, choose the currency you want to receive,
  and get paid with `payTag` / `payTagWithPermit` (USD₮ supports EIP-2612, so one signature replaces the approval).
  Limits per payment, per recipient per day, per payer per day and overall per day, per token, in that token's own units.
- **`LokalPots`**: one link, many payers (weddings, birthdays, group gifts). A pot has a dollar cap, a per-guest cap and
  a closing time, and takes any allowed token.
- **`LokalText`**: the text rules both contracts share, byte for byte the same as the site's.

Neither contract ever holds money: every payment goes straight to the agent's payout wallet in the same transaction,
and the agent converts it on Textile FX and pays the recipient. A new payout wallet waits 24 hours in public before it
takes effect; the admin (a separate wallet from the agent) can pause everything with one switch.

[![contracts](https://github.com/deeeko/lokal/actions/workflows/contracts.yml/badge.svg)](https://github.com/deeeko/lokal/actions/workflows/contracts.yml)
Solidity 0.8.30 · OpenZeppelin 5.6.1 · Hardhat + TypeScript · 135 tests (some of them send the site's own calldata), including the independent audit's attack
scenarios and a parity test that checks the contract against the site's live rules on thousands of random names.

**One command, the whole story.** `cd contracts && npm ci && npm run demo` deploys both contracts on a local chain and
plays out the table below. Every row is asserted, and CI runs it on every push, so this page can't drift from the code.

| # | Who | Action | Result | Why |
| --- | --- | --- | --- | --- |
| 1 | ada | Claim @ada | **ALLOW** | `TagClaimed`: @ada is hers |
| 2 | ada | Ask to be paid out in cNGN | **OK** | `ReceiveTokenSet`: the agent now knows her local currency |
| 3 | bob | Claim @ada | **REFUSE** | `TagTaken` |
| 4 | bob | Claim @lokal_support | **REFUSE** | `TagReserved` (brand names and lookalikes) |
| 5 | carol | Pay @ada $10 USD₮ | **ALLOW** | $10 goes straight to the agent's payout wallet; the contract holds $0 |
| 6 | carol | Pay @ada $30 USD₮ | **REFUSE** | `OverPaymentLimit` ($25): nothing moved |
| 7 | carol | Pay @ada $0.50 USD₮ | **REFUSE** | `BelowMinimum` ($1) |
| 8 | dave | Pay @ada $20 USD₮ ($10 already today, $25 per person per day) | **REFUSE** | `OverRecipientDailyLimit` ($15 left) |
| 9 | carol | Pay @bob $20 USD₮ (she paid $10 today, $25 per payer per day) | **REFUSE** | `OverPayerDailyLimit` ($15 left) |
| 10 | ada | Pay @ada $5 USD₮ | **REFUSE** | `SelfPayment` |
| 11 | carol | Pay @nobody $5 USD₮ | **REFUSE** | `TagNotFound` |
| 12 | carol | Pay @ada in a token the admin never allowed | **REFUSE** | `TokenNotAllowed` |
| 13 | carol | Pay @ada 446,369 IDRX (2 decimals, about $24) | **ALLOW** | Limits are per token, in its own units |
| 14 | 10 other payers | Pay @ada $15 and nine other tags $25 each in USD₮ | **ALLOW** | $250 in USD₮ today: the daily total, and it took 10 different payers |
| 15 | dave | Pay @hank $1 USD₮ | **REFUSE** | `OverDailyLimit` |
| 16 | carol | Next UTC day: pay @ada $25 USD₮ | **ALLOW** | A new day bucket: limits start again |
| 17 | ada | Claim @ada_obi | **ALLOW** | One tag per wallet: @ada is released and locked for 30 days |
| 18 | bob | Claim @ada | **REFUSE** | `TagLocked` |
| 19 | bob | Claim @ada 30 days later | **ALLOW** | The lock has ended |
| 20 | ada | Open a pot, "Ada & Tunde's wedding" ($20 cap, $5 per guest, closes in 6 hours) | **OK** | `PotCreated` #1: one link and QR code for every guest |
| 21 | guest 1 | Spray $2 USD₮ into the pot | **ALLOW** | `PotPaid`: straight to the payout wallet, pot total $2 |
| 22 | guest 1 | Spray $4 more | **REFUSE** | `OverPayerCap` ($3 left for this guest) |
| 23 | guests 2-4 | Spray $5 each, in USD₮, cNGN and IDRX | **ALLOW** | One pot takes any allowed token: $17 from 4 guests |
| 24 | guest 5 | Spray $5 | **REFUSE** | `PotFull` ($3 left of the $20 cap) |
| 25 | admin | Switch the payout wallet right away | **REFUSE** | `PayoutWalletNotReady`: a new payout wallet waits 24 hours, in public |
| 26 | admin | Pause | **OK** |  |
| 27 | carol | Pay @ada_obi $5 USD₮ | **REFUSE** | `Paused` |
| 28 | guest 5 | Spray $1 | **REFUSE** | `Paused`: one switch stops tags and pots |

All 28 outcomes asserted. LokalTags and LokalPots held $0 at every step.

**Who enforces what.** Not every rule can live onchain: the swap and the payout happen in the agent's code.
[docs/WHO-ENFORCES-WHAT.md](WHO-ENFORCES-WHAT.md) lists every rule and says whether the contract, the agent or
the site enforces it.

| | |
|---|---|
| Status | **Live on Celo mainnet since 21 Nov 2026.** Deployed by the agent with the ERC-8021 tag ([LokalTags tx](https://celoscan.io/tx/0x4d4aa9adba3417e9a7017a4c2e45b4cafe2380702e75f6f9350af7ac58af858e), [LokalPots tx](https://celoscan.io/tx/0x8e56d2a9e391a54589ab9e72d683d8307355c5f8b8fb2dd697bab62b65c3ebd9)). **Site and CLI switched** (built, not yet used on mainnet): Account claims, renames, sets the default currency and releases on LokalTags; tag pages and `lokal send` pay with `payTagWithPermit` / `payTag`; autopilot pays `TagPaid` and `PotPaid`. New claims go to the contract only from block 83,405,000; older `NTP:` memo payments keep being paid (see [Lokal tag rules](PROTOCOL.md#lokal-tag-rules)). |
| LokalTags | [`0xFF2f8ADC0c97B6E40b201848d378C11325bC7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187) · [Blockscout](https://celo.blockscout.com/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187?tab=contract) · [Sourcify, exact match](https://repo.sourcify.dev/42220/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187) |
| LokalPots | [`0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF`](https://celoscan.io/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF) · [Blockscout](https://celo.blockscout.com/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF?tab=contract) · [Sourcify, exact match](https://repo.sourcify.dev/42220/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF) |
| ABIs and addresses | [`contracts/deployments/`](../contracts/deployments/) (`LokalTags.json`, `LokalPots.json`, constructor arguments, deploy record) |
| Admin | [`0xc2808B63906F48C1BaCaa1E2Ad2e1Cb2A363A070`](https://celoscan.io/address/0xc2808B63906F48C1BaCaa1E2Ad2e1Cb2A363A070) (two-step transfer: [offered](https://celoscan.io/tx/0xd22cf761f5c768dad0b432fa27d0bea927db04ce344de10f3ce26af8dde66bda) by the deployer, [accepted](https://celoscan.io/tx/0xbee2dd85e15c4fb664397f06e1a0a932214c6c6a65aaa3aa99e599905c2ec3a6) from the admin's own wallet. The agent's key is not an admin) |
| Payout wallet | the agent, [`0x8a695cf54CB44753c8b784EB36d266f748617a1e`](https://celoscan.io/address/0x8a695cf54CB44753c8b784EB36d266f748617a1e) |
