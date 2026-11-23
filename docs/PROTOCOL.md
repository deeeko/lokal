# Protocol: tags, currencies, links and contract payments

The formats LokalPay puts on Celo and reads back: which currency a payment asks for, the LokalPay tag rules and the
cutover from the memo protocol, "Get paid" links, and how a payment through the contracts reaches the agent.

The full wire formats are kept as specs: [spec/NTAGS.md](spec/NTAGS.md) (the legacy `NT1:` claim and `NTP:` memo
formats, still paid for tags claimed before the cutover) and [spec/REGISTRATIONS.md](spec/REGISTRATIONS.md) (the
`NP1:` "Get paid" registrations and receipts).

## Currencies

LokalPay is multi-currency by design. Every local stablecoin below is on Celo mainnet and is priced by Textile FX against
USD₮. The payer picks the currency; all four are built, not yet used on mainnet.

| Country | Token | Issuer | Decimals | Today's rate (5 USD₮) | Status |
|---|---|---|---|---|---|
| 🇳🇬 Nigeria | [cNGN](https://celoscan.io/address/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f) (naira) | — | 6 | ₦7,205.67 | **Built, not yet used on mainnet** (USD₮ → cNGN, cNGN → USD₮, and CELO → cNGN for the operator) |
| 🇮🇩 Indonesia | [IDRX](https://celoscan.io/address/0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22) (rupiah) | — | 2 | Rp 92,035.51 | **Built, not yet used on mainnet** (`usdt-idrx`) |
| 🇦🇷 Argentina | [wARS](https://celoscan.io/address/0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D) (peso) | Ripio | 18 | ARS 8,826.31 | **Built, not yet used on mainnet** (`usdt-wars`) |
| 🇨🇴 Colombia | [wCOP](https://celoscan.io/address/0x8a1D45e102e886510e891d2Ec656a708991e2D76) (peso) | Ripio | 18 | COP 17,277.91 | **Built, not yet used on mainnet** (`usdt-wcop`; thin market: Textile could fill only about $6.71 on 21 Nov, so larger payments are refused, never switched) |

- **Rates** are live Textile FX previews for 5 USD₮ taken on 21 Nov 2026. They are free previews, not firm quotes, and
  they move; every payment gets its own firm quote at the time it is paid.
- **What "Built, not yet used on mainnet" means.** Payments by LokalPay tag, payment link, Get paid or the `lokal` CLI are paid out by the
  agent (by hand or on autopilot) in cNGN, plus the reverse corridor that pays USD₮. The flow is built and tested against
  live Textile quotes; the first real mainnet payout to a user is still pending and will be linked here with its
  transactions. No payout in IDRX, wARS or wCOP has been made yet.
- **How the currency is chosen.** The **payer** picks it on every payment ("What does @ada receive?"), on the site and
  in the `lokal` command; nobody has to choose a currency to sign up. The default is the recipient's optional
  preference, else naira. A payment through LokalTags carries the choice in `payTag`'s `bytes32 ref`: the ASCII text
  `cur:<code>` (`cngn`, `idrx`, `wars`, `wcop`, or `usdt` for dollars), left-aligned and zero-padded, so rupiah is
  `0x6375723a69647278` followed by 24 zero bytes. The agent reads it from the `TagPaid` event; a ref that isn't a
  currency (any other payer reference) chooses nothing, and the agent falls back to the recipient's default
  (`receiveTokenOf`, set on Account with `setReceiveToken`), then naira for USD₮ and dollars for cNGN. A legacy memo
  payment carries it as `NTP:<tag>:<code>` (plain `NTP:<tag>` still means naira, so existing payers keep working).
  Payment links and Get paid fix the currency in the link. Every amount uses the token's own decimals (IDRX 2, cNGN 6,
  wARS and wCOP 18) and is shown rounded down. If a currency has no Textile quote when the payment is handled, the
  payment is refused (`currency_unavailable`) and never paid in another currency.
- **Getting it to a bank.** The [cash-out guide](https://lokalpay.vercel.app/cash-out.html)
  ([docs/CASH-OUT.md](CASH-OUT.md)) gives each currency's checked route as of 21 Nov 2026. MiniPay only shows
  USDT, USDC and USDm, so recipients who cash out through MiniPay should take dollars.
- **Not yet supported.** Textile also lists wBRL (Brazil) and wMXN (Mexico), but neither returned a quote on 21 Nov, so
  LokalPay does not offer them.

## LokalPay tag rules

| Rule | Detail |
|---|---|
| Where | on the **LokalTags contract** ([`0xFF2f…7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187)): `claim`, `setName`, `setReceiveToken`, `release`, read with `tagInfo` / `tagOf` / `availability`. The contract enforces every rule below. |
| Format | 3–20 characters: lowercase letters, numbers and `_`, starting with a letter (`^[a-z][a-z0-9_]{2,19}$`), no `__`, not ending in `_`. The site and CLI normalise input (trim, strip one `@`, lowercase). |
| Display name | optional, 1–40 characters, no control characters, no invisible or text-direction characters (zero-width spaces and joiners, bidi marks, overrides and isolates); `setName("")` removes it |
| Default currency | optional (`setReceiveToken`): what the pay page pre-selects and what the agent pays when a payment names no currency. Payers choose per payment (`ref` = `cur:<code>`). |
| Reserved (63) | agent, admin, administrator, root, system, support, help, official, team, staff, mod, moderator, security, celo, minipay, valora, opera, textile, naira, nairapayout, payout, payouts, ntag, ntags, lokal, lokalpay, cngn, usdt, usdc, tether, cusd, ceur, wallet, bank, cbn, null, undefined, anonymous, everyone, me, you, test, demo, api, www, app, pay, send, receive, and the lookalikes lokal_support, lokalsupport, lokal_help, lokal_team, lokal_official, lokalofficial, support_team, help_desk, helpdesk, admin1, celo_team, celoteam, minipay_support, textile_fx |
| One tag per wallet | claiming another tag releases the old one |
| Release lock | a released tag stays locked for its previous owner's reclaim only, for **30 days** |
| Ordering | the contract applies claims in transaction order; a claim for a held tag reverts (`TagTaken`) and changes nothing |
| Public | tags, names and claim history are onchain, public and permanent |

**The cutover from the memo protocol (block 83,405,000, about 22 Nov 2026 00:00 UTC).** Before the contracts, tags
were claimed with zero-value `NT1:` transactions to the agent and paid with `NTP:` memo transfers. On 21 Nov 2026 the
agent's full history had **1** legacy claim (`@deekamix`, block 83,355,505) and **0** `NTP:` memo payments (read from
Blockscout's public API with the agent's own discovery code; no contract claim or payment yet either). From the
cutover block:

- **New claims go to the contract only.** An `NT1:` claim, rename or release mined in that block or later changes
  nothing (the site, the CLI and autopilot all ignore it); only legacy ops before it count.
- **Legacy memo payments keep being paid.** An `NTP:` payment to a tag held only the legacy way still pays its legacy
  holder, exactly as before, so nobody's money gets stuck. The site and CLI still offer that old transfer for such a
  tag, labelled as an older memo tag; its holder can claim the same name on the contract from Account.
- **A name held in both places: the contract owner wins.** New payments go through the contract to its holder, an
  `NTP:` memo payment from the cutover on pays the contract's holder at that block, and the site shows the contract's
  holder.
- **Frozen formats.** `NT1:`, `NTP:`, `NP1:`, `NP-` receipts and the sign-in text are unchanged.

The cutover block is `LEGACY_CUTOVER_BLOCK` in `src/config.mjs` and `site/assets/core.js` (a test keeps them equal).

**Legacy claims: same code on both sides.** The resolver block between the `port` markers in `site/assets/core.js` is copied
byte-for-byte into `src/ntags.mjs`, and `test/ntags.test.mjs` checks the copies are identical and give identical results
on a shared fixture set. The site and the agent therefore always agree on who owns a tag at any moment. For a deposit,
the agent resolves the tag strictly **before** the deposit (`resolveNtagsBefore(ops, block, position)`).

**Discovery.** Tag claims are read from Blockscout (`/addresses/<agent>/transactions?filter=to`). The agent loads the
full list once and then refreshes incrementally, re-reading the last 600 blocks each time so a reorg or late-indexed
block is picked up. It never works from a partial list: past the page limit it stops with an error, and a LokalPay tag deposit
above the height the list is complete to waits (requests and registrations before it carry on). Spam sent to the agent
cannot make it pay from a stale or partial list.

## Payment links ("Get paid")

`get-paid.html` lets someone publish a payment request **from their own wallet**: one zero-value transaction to the
agent whose input is `hex("NP1:" + JSON)` plus the attribution tag:

```json
{ "a": "5.03", "d": "usdt-cngn", "e": 1796000000, "n": "Ada", "m": "school fees" }
```

(`a` amount, `d` corridor, `e` expiry in unix seconds, at most 168 hours, `n` name, `m` optional note.) The recipient
is the transaction's sender, proven by its signature, so the address cannot be mistyped. The link is
`pay.html#tx=<registration hash>`. Name, note, amount and wallet are public and permanent onchain.

The operator can also create links for allow-listed contacts from the command line (`request`), which gives
`pay.html#r=<token>` with a unique amount (see [Run it yourself](CLI.md#the-agent-cli)).

### Pay a link

The payer opens the link and sees who is paid, the exact amount, the corridor, the expiry and a live estimate. They
can **connect a wallet and pay** in one step (the page builds the exact transfer plus the attribution suffix, checks
the network is Celo and refuses the agent's own wallet), or use "Open in wallet", the QR code, or send the exact
amount by hand. When several "Get paid" links use the same corridor and amount, only the earliest is **active**; the
others show **amount in use** and are never paid.

## Payments through the contracts (`TagPaid`, `PotPaid`)

Inside one `payTag` / `payTagWithPermit` / `payPot` the contract checks every limit, moves the tokens from the payer
straight to its payout wallet (the agent) with **one `transferFrom`**, and only then emits the event. So when autopilot
sees `TagPaid(tagHash, tag, recipient, payer, token, amount, ref, dayIndex)` or `PotPaid(potId, host, payer, token,
amount, ref, ...)`, the money is already in the agent wallet and the event names who to pay (`src/contract-watch.mjs`):

1. **Discovery.** Plain `eth_getLogs` on LokalTags and LokalPots over the same block range, cursor and indexed head as
   the deposits (no Blockscout needed), handled in chain order with them.
2. **The money arrived.** The transaction's receipt must hold the inner Transfer of exactly `amount` of `token` from
   the payer to this agent, just before the event. That Transfer *is* the payment: it is removed from the deposit path,
   so it can never be matched to a payment request or "Get paid" link by amount, or logged as unmatched. If the money
   went to another payout wallet, the event is recorded as refused and nothing is paid.
3. **What they get.** The payer's choice in `ref` (`cur:<code>`), else the recipient's default (`receiveTokenOf` at
   the payment's block), else naira for USD₮ and dollars for cNGN; a pot with no choice pays dollars. USD₮ converts on
   `usdt-<code>`, cNGN on `cngn-usdt`; a payment already in the token they get is passed on as is (`src/forward.mjs`:
   same recipient rules and caps, exact amount, attribution tag, logged to `receipts.jsonl`). Any other pair (cNGN to
   rupiah, say) is refused, never paid in another currency.
4. **The same safety path.** Pre-flight (recipient rules, the agent's own caps, a live preview), the payment recorded
   in `contract-payments.json` **before** paying, exactly once per event (`tx:logIndex` of the event), then `pay()`:
   firm quote, exact approval, measured payout, attribution tag. The contract's limits are an outer bound: the agent's
   own caps still apply, and a refusal is recorded like any other (a rescan never pays it).
5. **Refunds.** A refused contract payment is a refundable deposit, keyed by its inner Transfer
   (`refund --deposit <tx>:<logIndex of the Transfer>`), so it goes back to the payer the event names, never to the
   contract. `--auto-refund` does it right away; a deposit with a refund record is never paid. It all runs inside
   `watch --execute`, under the same agent lock.
