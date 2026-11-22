# Status and roadmap

## Status today

Three labels, used here and in the README's "What's real" table. The site lists what works on the
[Features page](https://lokalpay.vercel.app/features.html), with what isn't built yet under "Coming soon".
**Live** (used with real money on Celo mainnet, with a transaction link) ·
**Built, not yet used on mainnet** (code and tests exist; no real payout yet) ·
**Planned** (not built yet).

- **Live:** the LokalTags and LokalPots contracts are deployed and verified on mainnet (see
  [The contract has the final say](CONTRACTS.md#the-contract-has-the-final-say)). No real user payout yet.
- **Built, not yet used on mainnet:** payouts in naira, rupiah and pesos (plus naira → dollars), the currency
  picker, Lokal tags, **paying and claiming through the contracts** (site, `lokal` command and autopilot), payment
  links, Get paid, [pots and the Spray Wall](ARCHITECTURE.md#pots-one-link-many-guests), autopilot, refunds, the `lokal` command,
  receipts and reviews, the [cash-out guide](https://lokalpay.vercel.app/cash-out.html), the sign-up gateway, the
  dashboard, "Add to wallet", the ["Who am I paying?"](ARCHITECTURE.md#who-am-i-paying) card and the [Proof page](ARCHITECTURE.md#proof).
- **Planned:** Pay with CELO for payers, "Pay for me" (a payment link
  with a title, note and share message, for someone else to pay), MiniPay mode.

## Roadmap

**Done**

- [x] Agent on Celo mainnet, 346 tests passing (plus 135 contract tests)
- [x] Live Textile price previews for all three corridors
- [x] ERC-8004 identity registered (agentId 10079)
- [x] Payment links, Get paid, autopilot, two stablecoin corridors plus CELO, receipts and onchain reviews
- [x] Lokal tags, wallet sign-in and the `lokal` CLI (first shipped as `ntag`)
- [x] Live app on Vercel behind a test-gated deploy
- [x] Status server: exact payout status and daily limits on the site
- [x] One-line Windows installer for the `lokal` command (`ntag` kept as an alias)
- [x] Renamed to Lokal, at lokalpay.vercel.app (naira-payout.vercel.app keeps working)
- [x] Live Textile FX quotes checked for rupiah (IDRX) and pesos (wARS, wCOP), see [Currencies](PROTOCOL.md#currencies)
- [x] LokalTags and LokalPots contracts deployed on Celo mainnet and source-verified; admin held by a separate wallet
- [x] Site, `lokal` command and autopilot switched to the contracts (built and tested, not yet used on mainnet)
- [x] A story-telling landing, a sign-up gateway and a private dashboard; the activity feed is for the signed-in wallet only
- [x] "Who am I paying?" on every tag page, and a public Proof page that reads every real payout from Celo
- [x] Pots and the Spray Wall on the site (built and tested, not yet used on mainnet)
- [x] A six-section landing, with every feature and its label on the Features page

**Still to do** (added here only once they have happened)

The operator steps for these are in [docs/RUNBOOK.md](RUNBOOK.md).

- [ ] Tagged mainnet run: USD₮ to cNGN to a named recipient, with transaction links
- [ ] Named user and what they used it for

**Next**

- **Dollar subscriptions paid in local money.** Local cards are often declined or capped for dollar subscriptions (X
  Premium, ChatGPT, Canva, app stores). The naira → dollar corridor already converts cNGN to USD₮ on Textile FX; pairing
  it with a stablecoin-funded virtual card or gift-card partner lets people pay those subscriptions in naira, and in
  rupiah or pesos once those corridors run both ways.
- **Cash-out:** a direct handoff from the local stablecoin to a local bank account through off-ramp partners, starting
  with cNGN to a Nigerian bank account.
- **MiniPay mini-app:** claim a tag and get paid without leaving MiniPay.
- **More currencies** as Textile FX adds pairs (wBRL for Brazil and wMXN for Mexico are listed but had no quote on
  21 Nov).
- **Always-on autopilot** on a hardened server with a separate, low-balance key.
- A custom domain.

**How it follows the hackathon rules**

- **Celo mainnet only.** Textile's sandbox does not cover Celo, so the swap path is checked with free live previews and
  tests, and real runs use small amounts.
- **No self-trading or arbitrage.** One conversion per payout (two for `celo-cngn`, because there is no direct CELO →
  cNGN pair). The agent is not a market maker.
- **Independent users.** Payers and recipients are people outside the team whose wallets the builder did not fund.
- **ERC-8004 identity and reputation**, and the **attribution tag on every transaction**.

## Business model

Lokal is for "Agents Open for Business", so here is how it pays for itself, labelled like everything else.

- **Today: no fee.** The payer gets Textile FX's rate exactly as quoted, and the operator pays the gas. Each payout is
  a handful of Celo transactions (reset, approve, swap, transfer), which costs a fraction of a US cent each.
- **Planned: a small, visible fee.** A fee in basis points with a small minimum (`FEE_BPS`, `FEE_MIN_USD`), taken
  from the bought amount and shown on every quote, payment screen, CLI summary and receipt *before* the payer signs.
  Limits apply to the gross amount. Not built yet.
- **Planned: paid features for businesses.** Payment links and Pots for freelancers, shops and events (one QR code,
  many payers), and later the dollar-subscription corridor in [Status and roadmap](#status-and-roadmap).

Why people would pay: sending dollars home or to a freelancer usually means a bank or money-transfer fee *and* a
weak exchange rate. Lokal shows the exact rate and the exact amount the recipient gets before anyone signs, and pays
their own wallet in seconds.
