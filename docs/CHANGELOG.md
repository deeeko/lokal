# Changelog

Newest first. This was the README's progress log; it moved here when the README was cut to one page.

## 2026-11-24: "Max" in the amount field

- **Max** inside the amount field on tag pages and pot sprays fills in the most the connected wallet can send right
  now: the smallest of its balance of the token being paid, the most per payment ($25, or about $24.25 in a local
  token, and the contract's `tokenLimits`), today's room for that recipient and payer, and for a pot its room and the
  guest's cap left. It rounds down to the field's 2 decimals, never fills less than the $1 minimum (it says why
  instead), and when a limit rather than the balance sets it, one line says which ("Max is $25: the most per payment").
  Off until a wallet is connected and its balance is read; payment links keep their fixed amount.
- `maxSendable()` (site/assets/lokal-contracts.js) does the arithmetic, with table-driven tests for 2, 6 and 18
  decimals, every limit binding, rounding down, a balance under the minimum and an unknown balance. The wallet line on
  tag pages now rounds the balance down too, so it never shows more than Max will fill.

## 2026-11-23: pay in rupiah or pesos, they get dollars

- **Three reverse corridors**, `idrx-usdt`, `wars-usdt` and `wcop-usdt`, next to `cngn-usdt`: the payer sends IDRX,
  wARS or wCOP and the recipient gets USD₮ ([PROTOCOL.md](PROTOCOL.md#currencies)). A `TagPaid` or `PotPaid` in one
  of them with "dollars" chosen (or the recipient's default being dollars, or a pot) now pays out through the matching
  corridor instead of being refused. Amounts keep each token's own decimals (IDRX 2, wARS and wCOP 18) to the last
  unit; the caps are counted in USD from the preview and the firm quote; a live preview under $1 is a permanent
  refusal. They are for contract payments and the operator's `pay` / `quote`; payment links, Get paid and legacy
  memos are unchanged (USD₮ and cNGN only).
- **"You pay with: USD₮ · Change"** on tag and pot pages: pick "Dollars" and pay with USD₮, cNGN, IDRX, wARS or wCOP
  (whatever the agent pays out). The estimate and the limits use the paid token's decimals, its reverse rate and the
  contract's per-token limits; the contract's dry run still runs before the wallet opens. The quote page offers the
  reverse quotes too, and the rate feed now carries `reverseRates` for every currency.
- Status events now cover contract payments in any Lokal token. New tests for the corridors, every routing pair, the
  cap valuation, the $1 floor and the site's pay-with tokens and estimates.

## 2026-11-23: Renamed to LokalPay

- **The product is now LokalPay** everywhere a person reads its name: every page's title, meta and share tags, the
  wordmark, top bars, sidebar and footer, the README and docs, the CLI help and messages, alerts ("LokalPay agent:"),
  the Windows installer and the ERC-8004 card in `src/register8004.mjs` (the onchain card changes the next time it
  is rewritten with `setAgentURI`). "Lokal tag" reads "LokalPay tag".
- **`lokalpay` is another name for the command line**: `package.json` bin, and the installer writes
  `bin\lokalpay.cmd` next to `lokal.cmd` and `ntag.cmd`. `lokal` stays the main name.
- **Unchanged on purpose:** the hero's *lokal* wordplay and the logo; the deployed `LokalTags` and `LokalPots`
  contracts; the repo and its addresses (lokalpay.vercel.app, naira-payout.vercel.app); storage keys, receipt
  prefixes, the attribution code, the onchain memo formats; and the sign-in text ("Sign in to Lokal…"), which the
  server checks, so sessions keep working. Refusal reasons written before the rename keep their codes.

## 2026-11-22: calmer payment screens

- **Show what you need, hide what you might need** ([the website](ARCHITECTURE.md#the-website-landing-sign-up-dashboard)):
  the tag, payment-link and pot screens open on what they receive, the amount, the "gets about" number and Pay; the
  rate, route, limits and "Who am I paying?" fold into one line each. Warnings and refusals are never folded.
- **QR codes on demand and one Share button**: every QR is drawn only when "Show QR code" is opened; Share uses the Web
  Share API (Copy link and WhatsApp where it isn't there). The dashboard's Settings are folded.
- **A calm confirmation** after paying a tag, a link or a pot (a big check, one sentence, Done), with the transaction
  in Details. `site/assets/disclose.js`, 11 new tests, `scripts/screenshots-simple.mjs`.

## 2026-11-22: a notification bell

- **Notification bell** (top right when signed in, on every app page and the landing, Features and Proof top bars):
  a count of new incoming payments (1–9, then 9+) and a small dropdown of the latest five: money received, payments to
  your tag, sprays into your pots and refunds, each linking to its receipt, Activity, the pot or the refund
  transaction. Payers are never named. It checks on load, then every minute while the tab is visible, sharing one
  read with the dashboard and Activity; only a "last seen" time per wallet is kept (`np-notif-seen`, in the privacy policy).
- Tests for the event-to-item mapping, the unread count with and without storage, the polling rhythm and the gating;
  `scripts/screenshots-bell.mjs` takes the bell and its dropdown at 390 px and 1440 px.

## 2026-11-21: a six-section landing, a Features page and a one-page README

- **Landing** ([the website](ARCHITECTURE.md#the-website-landing-sign-up-dashboard)): six sections with one job each:
  the hero and its live converter, how it works in three lines, the four countries as a live rate board, why it's
  safe, Proof (one honest line above the real payouts) and the last word with four questions. 4,474 px tall at 1440 px,
  down from 10,395.
- **Features** (`features.html`): everything Lokal does, listed plainly with a try-it link, and one small "Coming
  soon" list (MiniPay mode, Pay with CELO, Pay for me). The per-item status pills and the Status today box are gone
  from the site; the README keeps one status table. Proof and Features now share the landing's top bar and footer, and
  `scripts/check-site.mjs` holds them to it.
- **README** cut to one page: what's real with receipts, how a payout works, currencies, safety, Track 3 and how to run
  it. Its detail moved, nearly verbatim, into [ARCHITECTURE.md](ARCHITECTURE.md), [CLI.md](CLI.md),
  [PROTOCOL.md](PROTOCOL.md), [CONTRACTS.md](CONTRACTS.md), [OPERATOR.md](OPERATOR.md), this changelog and
  [ROADMAP.md](ROADMAP.md).
- `scripts/screenshots.mjs --front` takes the landing (whole page and each section), Features and Proof.

## 2026-11-21: Pots and the Spray Wall on the site

- **Pots on the site** ([Pots](ARCHITECTURE.md#pots-one-link-many-guests)): open, share and close a pot from the dashboard; guests
  spray from `pot.html?id=N` with no account, every refusal explained before the wallet opens.
- **The Spray Wall**: the pot's `PotPaid` events, live, amounts and times only.
- Tests: 310 (`test/pots-site.test.mjs`), plus `contracts/tests/SitePots.spec.ts` sending the site's pot calldata to
  the real LokalPots (135 contract tests).

## 2026-11-21: "Who am I paying?" and the Proof page

- Tag pages show the tag's age, payments received and owner, with one-line warnings (first-time payee, new tag,
  changed hands, lookalike, name changed) read from Celo; none blocks payment, and unread facts say "Couldn't check".
- `proof.html` lists every real payout read from Celo, with totals, both transactions and the attribution check.
- Tests: 321 (new: `test/trust.test.mjs`, `test/proof.test.mjs`).

## 2026-11-21: the front door: a landing that tells the story, a sign-up gateway and a private dashboard

- **Landing at `/`** ([the website](ARCHITECTURE.md#the-website-landing-sign-up-dashboard)): one story top to bottom, with a live
  converter in the hero ($10 → naira, rupiah and both pesos from the live Textile FX rate; over $25 it says the contract
  would refuse it), the four countries with live rates, an index of **everything Lokal does** with honest
  Live / Built / Planned labels and try-it links, the contracts on Celoscan, the cash-out route, Proof (real payouts read
  from Celo, with an honest empty state; no invented numbers, users or testimonials), developers and an FAQ.
- **Sign-up gateway** (`start.html`): Connect → Sign in → Your tag → Your name → Welcome, with a progress line. The tag
  and name go out in one `claim` transaction. No email, no password, no currency required.
- **Dashboard** (`app.html`): your tag, money received, recent payments (only yours), your payment links, quick actions,
  **Add to your wallet** (`wallet_watchAsset` for cNGN, IDRX, wARS, wCOP and USD₮) and settings (name, default
  currency, release). Signed-in visitors who open `/` land here; "About Lokal" (`index.html?about`) shows the landing.
- **The activity feed is for the signed-in wallet only.** Activity shows your own payments; visitors get a sign-in prompt.
  The landing no longer shows the agent's feed, and the autopilot board no longer prints wallet addresses. Payer pages
  stay public.
- **Navigation:** Dashboard · Send · Get paid · Activity · Account · Docs. Below 1100 px the top bar is a full-width bar
  with its height reserved, so it never covers content (it used to float over the Account claim summary).
- **Refined palette and motion**: deeper greens, AA text contrast, yellow only where it matters, press feedback, calm
  reveals, reduced-motion / reduced-transparency / more-contrast support.
- `scripts/check-site.mjs` now checks the exact sidebar, allows the landing's and gateway's own chrome on purpose (with
  their own rules), and checks that Activity starts hidden for visitors. `scripts/sync-chrome.mjs` copies the chrome;
  `scripts/screenshots.mjs` takes the screenshots. Privacy page updated.
- Tests: 296 (new: `test/front-door.test.mjs`, the redirect, gating, gateway steps, add-to-wallet params, "Yours" rows).

## 2026-11-21: tags and payments through the contracts

The site, the `lokal` command and autopilot now use the live LokalTags and LokalPots contracts (built and tested, not
yet used on mainnet):

- **Account** claims, renames, sets the optional default currency and releases a tag with `claim`, `setName`,
  `setReceiveToken` and `release`, each simulated first and read back from the contract over RPC (no explorer wait).
- **Tag pages** read holders from the contract and pay with one `payTagWithPermit` signature for USD₮ or approve +
  `payTag` for cNGN, after showing the contract's room today and explaining any refusal (`OverRecipientDailyLimit`,
  `SelfPayment`, `Paused`, ...) before the wallet opens. Wallets see a contract call, not a memo transfer.
- **The payer still chooses the currency** on every payment: it travels in `payTag`'s `ref` as `cur:<code>`, and the
  agent falls back to the recipient's default, then naira.
- **Autopilot** reads `TagPaid` and `PotPaid` with `eth_getLogs`, pays through the same safety path exactly once per
  event, drops the payment's inner Transfer from the deposit path (a test proves it is never matched to a link), and
  makes refused contract payments refundable to the payer.
- **`lokal claim / send / whois / release`** use the contracts, with the same prompts, encrypted wallet and `--dry-run`.
- **Cutover**: legacy claims from block 83,405,000 on are ignored; legacy memo payments keep being paid; the contract
  owner wins a name held in both places. Counted on mainnet first: 1 legacy claim, 0 memo payments.
- **Refunds on the site**: "Refunded · RF-XXXX-XXXX" with the refund transaction, on pay, tag and account pages.
- Tests: 288 root tests (new: contract events, the payer's currency in the ref, revert decoding, the attribution
  suffix, refunds of contract payments, refunded statuses) and 130 contract tests, including a Hardhat test that sends
  the site's own calldata to the real contracts.

## 2026-11-21: refunds, autopilot lock and alerts

Three operator-safety gaps an external review flagged, closed in code and tests:

- **Refunds** ([Refunds](OPERATOR.md#refunds), [docs/REFUNDS.md](REFUNDS.md)): `refunds` lists every refused, unmatched
  (incl. expired or used links) and ambiguous deposit; `refund --deposit <tx>:<logIndex>` sends one back to its
  sender in the same token and amount (any of the five tokens, in its own decimals). Dry run with a gas estimate; with
  `--execute`: yes → lock → re-read over RPC → checks → `sending` recorded in `refunds.json` → tagged transfer →
  receipt checked → `refunded` with an `RF-XXXX-XXXX` number → `receipts.jsonl` (`kind: "refund"`, skipped by the payout
  caps) → status report. Never a paid deposit, a top-up, a swap output or a reactor transfer; own cap of $100 a day
  (`MAX_DAILY_REFUND_USD`), nothing under $1 (`MIN_REFUND_USD`). A failed refund is never retried by itself;
  `--retry` searches the chain first. Autopilot and `retry --force-refused` never pay a refunded deposit.
  `watch --execute --auto-refund` (opt-in) refunds refused tag and Get paid deposits, at most 3 per payer a day.
- **One agent at a time** (`src/lock.mjs`): `watch --execute` and every `--execute` command take `agent.lock`
  (`wx`, pid/host/start/command); a live holder is refused, a stale one needs `--clear-stale-lock`; released on exit,
  Ctrl+C, SIGTERM and crashes. Autopilot also stops cleanly on SIGTERM now.
- **Alerts and liveness** (`src/alerts.mjs`): Telegram and/or a webhook, through an outbox that never blocks a payout:
  autopilot stopped, payout failed, refund failed, daily cap, CELO low (default 3 CELO, checked once a minute,
  re-warned hourly), status server down 10 minutes, deposit refused, payout paid. `alert-test` checks the setup. When
  autopilot stops on an error its last line says what happened and the exact resume command.
- **Heartbeat**: a signed heartbeat about once a minute; the status server keeps it apart from the deposit records and
  answers `GET /api/status?agent=1` ([shape](OPERATOR.md#agent-heartbeat-get-apistatusagent1)). A GitHub Actions watchdog
  (`agent-watchdog.yml`) alerts on Telegram after 10 minutes of silence, re-alerts hourly, and says when it is back.
- **Status server**: a new **refunded** status (`refundTx`, `refundNo`), which beats refused / failed / received;
  nothing beats paid; paid + refunded for one deposit is logged as a conflict and never merged.
- **`doctor`**: PASS / WARN / FAIL for the lock, Forno, Blockscout lag, a $1 Textile preview, CELO gas, the status
  secret (never printed), the state files, refundable deposits and token decimals.
- **`test/invariants.test.mjs`**: the twelve money-safety invariants, one test each, against the real `pay()`, guards,
  autopilot, refund flow, wallet client and site resolver. 61 new tests in all (258).

## 2026-11-21: rupiah and pesos, the currency picker and the cash-out guide

- **Four currencies.** The payer picks naira, rupiah, Argentine peso or Colombian peso on every payment screen
  (Overview, Send, tag pages, Get paid, Account, payment links) and with `lokal send ada 10 --to rupiah`. New corridors
  `usdt-idrx`, `usdt-wars` and `usdt-wcop` run through the same firm quote, exact approval, measured payout and
  attribution check as naira. One currency list (`src/currencies.mjs`) is shared byte for byte with the site.
- **All four rates** in the sidebar; limits shown in dollars and in the chosen currency.
- **Tag owners can prefer a currency**, and Lokal tag memos can name one (`NTP:<tag>:<code>`).
- **[Cash-out guide](https://lokalpay.vercel.app/cash-out.html)** for each currency, with a MiniPay warning.
- A bug found on the way: two payment links with the same amount in different local currencies would have been
  ambiguous, since both are paid in USD₮. The one-active-link-per-amount rule now groups by the token the payer sends.
- 197 tests (20 new, covering 2, 6 and 18 decimals).

## 2026-11-21: honesty pass, business model and SECURITY.md

- **Three labels, used everywhere:** Live (used with real money on mainnet), Built, not yet used on mainnet, and
  Planned. A "Status today" box near the top says which is which. Rupiah and pesos, Pots on the site, "Who am I
  paying?", Pay with CELO and the cash-out guide are now labelled Planned in the text and in both diagrams.
- **Business model** section: no fee today; a visible fee and paid business features are Planned.
- **SECURITY.md** with private reporting through GitHub (turned on for the repo); `engines` set to Node 20+;
  progress-log dates corrected to the real commit dates.

## 2026-11-21: the contracts: LokalTags and LokalPots, live on Celo mainnet

- **Deployed** on Celo mainnet: LokalTags [`0xFF2f8ADC0c97B6E40b201848d378C11325bC7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187), LokalPots [`0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF`](https://celoscan.io/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF), both source-verified
  (Sourcify exact match), every transaction attribution-tagged. Admin handed to a separate wallet (two-step, accepted the same evening).
- **`contracts/`** (Solidity 0.8.30, OpenZeppelin 5.6.1, Hardhat + TypeScript): `LokalTags` (tag registry and payment
  router with per-token limits) and `LokalPots` (one link, many payers). Neither holds money. See
  [The contract has the final say](CONTRACTS.md#the-contract-has-the-final-say).
- An independent audit found one high, one medium and five low issues; all fixed: lokal/lokalpay and 14 lookalikes
  reserved (63 names), per-payer daily caps, invisible and text-direction characters refused in names (site, agent and
  contract alike), a 24-hour public wait before the payout wallet can change, two-step admin transfer, `rescue` for
  tokens sent by mistake.
- 127 contract tests plus a 28-step demo that CI asserts on every push (`.github/workflows/contracts.yml`), and
  [docs/WHO-ENFORCES-WHAT.md](WHO-ENFORCES-WHAT.md).

## 2026-11-21: Lokal tags, the `lokal` command and the repo move to deeeko/lokal

- **nTags are now Lokal tags.** Every page, receipt, message, the docs, privacy and terms say "Lokal tag" ("Claim your
  Lokal tag", "Pay a Lokal tag"). Only the words changed: the onchain formats (`NT1:` claims, `NTP:` memos), the
  resolver and every existing claim are untouched, so all tags keep working. `lokal` and `lokalpay` are now reserved.
- **The CLI is `lokal`.** `lokal send ada 10`, `lokal whois ada`, `lokal wallet new`. The installer writes
  `bin\lokal.cmd` and keeps `bin\ntag.cmd` as an alias, so `ntag` still works; `npm link` installs both names.
- **Repo rename prepared.** Links, the installer's download (`codeload.github.com/deeeko/lokal`), the GitHub Pages
  path (`/lokal/`, used by `404.html` and the rate fallback) and the package name now say `lokal`. GitHub redirects
  the old repo URL. Autopilot's status codes still read refusal reasons written before the rename.
- README now covers every supported currency.

## 2026-11-21: nTags, wallet sign-in, the `ntag` CLI and a safety pass

- **Status server.** Autopilot now reports every deposit it handles (paid with receipt, refused with reason,
  received) to a signed `/api/status` on Vercel, backed by a private Blob. The tag page, account page and payment
  links show exact status and exact room under the daily limits, and fall back to chain estimates if it is down.
- **nTags protocol.** Handles tied to a wallet, claimed and released with zero-value `NT1:` transactions to the agent;
  paid with an `NTP:` memo on an ordinary token transfer. One resolver, shared byte-for-byte by the site and the agent
  and cross-checked by tests.
- **Autopilot pays tags.** `watch` recognises memo payments, resolves the tag as it stood just before the deposit,
  re-reads the winning claim over RPC, applies the recipient rules and caps, records the deposit in `ntag-payments.json`
  and then pays the owner's wallet. New operator commands: `ntag`, `ntags`, `pay @tag`, `ntag-data`, `retry --ntag`.
- **Account setup guide.** `account.html`: Sign in → Your name → Claim your @nTag → Done, with live availability,
  suggestions, a tag card preview, a public-and-permanent confirmation, and confirmation once the claim is indexed.
  Change or release the tag, see wallet balances and payments to the tag.
- **Public tag pages and `/@tag` links.** `tag.html` and the Vercel rewrite `/@ada`; share by link, QR or WhatsApp.
- **Pay by tag with live payout tracking.** One transfer from the payer's wallet, then live tracking from confirmation
  to the agent's payout and receipt number, surviving a reload.
- **Wallet sign-in with a server check.** Free signed-message sign-in; `api/session.js` verifies it statelessly,
  including smart-contract wallets.
- **The `ntag` PowerShell CLI.** `wallet new/import/password`, `whois`, `send` (`--dollars`, `--wait`, `--dry-run`),
  `claim`, `release`, `status`; the key encrypted with a send password (scrypt + AES-256-GCM) and a lockout.
- **One-line Windows installer.** `irm https://lokalpay.vercel.app/install.ps1 | iex` installs `ntag` for the
  current user in about a minute: Node.js 20+ check, GitHub zip pinned by `NTAG_REF`, `npm ci --ignore-scripts`,
  atomic swap, user PATH. Run it again to update; `NTAG_UNINSTALL=1` removes it. It never touches the wallet file.
- **Daily limits on every payment screen.** $25 per payment, $25 per person per day, $100 per day overall, plus how much
  more a tag owner can receive today.
- **Connect and pay on payment links.** Pay a link straight from a connected wallet, with network and own-wallet checks.
- **"Yours" tab in Activity.** Signed-in users see their own payments to and from the agent.
- **Simpler navigation.** The sidebar went from 14 items to 6 (Overview, Send, Get paid, Activity, Agent, Docs), with
  tab strips for the pages inside each section.
- **Money-safety hardening from independent reviews.**
  - *Memo guard*: anything that looks like an nTag payment is never matched by amount to a request or registration.
  - *Recorded refusals*: refused deposits are recorded as handled, so rescans never pay them; only a deliberate
    `retry --force-refused` can.
  - *Exactly once on write failures*: a deposit is handled only when its writes finished; a failed "paid" write stops
    autopilot and says it was paid; a refusal from the firm quote un-records the deposit cleanly.
  - *Spam-resistant tag discovery*: full load once, incremental refresh with a 600-block re-check, page limits, never a
    partial list; nTag deposits wait until the list covers their block.
  - *Block-time verification*: the winning claim's block time is re-read over RPC and must match what the resolver used.
- **Receipt page fix.** Restored the receipt link base so receipt links resolve again.
- **Mobile and accessibility polish.** Works at 360 px wide, visible focus, live regions for async status, reduced
  motion respected.

## 2026-11-21: pay from CELO and the new address

- **Renamed to Lokal ahead of multi-currency corridors.** Naira Payout is now **Lokal**: "pay anyone in their local
  money". The layout, type and colours are unchanged; the names, copy and logo mark changed (a cursive L cut from the
  site's own Sentient Italic, in three variants under `docs/brand/`). New address **lokalpay.vercel.app** for links,
  receipts, the installer and `SITE_URL`; naira-payout.vercel.app keeps working, and the sign-in check accepts both
  (plus sign-ins signed before the rename, until they expire). `ntag` installs to `%LOCALAPPDATA%\lokal` (an old
  `naira-payout` install and its PATH entry are cleaned up on update) and new wallets go to `~/.lokal/wallet.json`,
  while an existing `~/.naira-payout/wallet.json` keeps being used in place. cNGN and the naira corridor are unchanged.
- **CELO payout corridor** (`celo-cngn`): the operator can pay in naira from the agent's CELO, as two Textile swaps
  (CELO → USD₮ → cNGN) with a 1.05 USD₮ minimum, a 2 CELO reserve plus gas margin, both swaps checked against their
  previews, and a recovery message if it stops halfway. Shown as "From CELO" on the quote page.
- **naira-payout.vercel.app**: payment and receipt links now point at the Vercel address (`SITE_URL`).
- **Disconnect wallet** on Get paid and the receipt rating flow (revokes access where the wallet supports it).
- Local Vercel link files are git-ignored.

## 2026-11-20: from first agent to live app

- **Get paid**: recipients publish their own payment request from their own wallet (onchain `NP1:` registration);
  autopilot pays the registration's sender after re-reading it over RPC, with the per-wallet daily cap.
- **Receipts for every transaction**: NP receipt numbers, saved as image or PDF, shared on WhatsApp or by QR; Receipt
  buttons across the site; older-browser support.
- **Vercel hosting and the CI/CD deploy gate**: tests and the site check run on every push; deploys only after they
  pass. Live `/api/rate`, a cached read-only explorer proxy, security headers. The GitHub Pages copy stays as a mirror.
- **Payment links and autopilot**: unique-amount requests, links, deposit matching and `watch --execute`.
- **The reverse corridor** (`cngn-usdt`): pay someone in dollars from naira, with the cap checked on the bought USD₮.
- **Onchain reviews**: payers rate payouts in the ERC-8004 Reputation Registry from their own wallet.
- Privacy and terms pages; self-hosted fonts; a fixed mobile app bar.
- **Shared ABI codec and payment-link format**, tested against viem.
- **Site redesign**: a collapsible glass sidebar (docked on desktop, drawer on mobile), a new naira logo with Celo yellow
  rails, a multi-page site (overview, quote, transactions, agent, verify, docs), contrast, focus and loading-state polish,
  and an Open Graph card. Untagged transactions are flagged in the pay flow.
- **ERC-8004 registration**: agentId **10079** on Celo mainnet
  ([register](https://celoscan.io/tx/0x080d54275f02a722a3b0daa408f02a1af760e29f9e39092a9a48d22b964cf62e),
  [update URI](https://celoscan.io/tx/0x4a342d9d0c7417211839b75edf7a9343e461b3dbe101aa39e53e14a09e7df309)), tags
  verified onchain.
- **First live page** on GitHub Pages: a live naira quote, the agent's identity and its tagged transactions, all read
  from Celo in the browser.
- **The first payout agent**: converts USD₮ to cNGN on Textile FX and pays an allow-listed recipient on Celo mainnet,
  with the cap, allow-list, slippage check and dry-run default enforced in code and the attribution tag on every
  transaction.
