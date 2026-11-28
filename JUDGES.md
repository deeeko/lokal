# LokalPay: guide for judges

What to check, in order, and what you should see at each step. Then a complete list of everything LokalPay has,
each part labelled with how far it has gone. Everything is on Celo mainnet and can be checked on public explorers.

| Live app | Real user paid | Demo video | ERC-8004 |
|---|---|---|---|
| [lokalpay.vercel.app](https://lokalpay.vercel.app) | [Alvo, Lagos: NP-B50B-488C](https://lokalpay.vercel.app/receipt.html#NP-B50B-488C) | [YouTube (1:53)](https://youtu.be/ooTuNiu4xzM) | [agentId 10079](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=10079) |

## Contents

1. [LokalPay in one minute](#lokalpay-in-one-minute)
2. [Check the onchain proof](#check-the-onchain-proof) (about 5 minutes)
3. [Try the website](#try-the-website) (about 3 minutes, no money needed)
4. [Everything LokalPay has](#everything-lokalpay-has), labelled
5. [Safety: every limit and who enforces it](#safety-every-limit-and-who-enforces-it)
6. [Run the tests](#run-the-tests)
7. [The judging criteria](#the-judging-criteria)
8. [Track 3 requirements](#track-3-requirements)
9. [Where to look in the code](#where-to-look-in-the-code)
10. [What is not done yet](#what-is-not-done-yet)

**The three labels used below:**
**Live** means used with real money on Celo mainnet, with a transaction to check.
**Built and tested** means the code and its tests exist and it works on the live site or command line, but no real
money has gone through it yet.
**Planned** means not built yet.

---

## LokalPay in one minute

- **What it does:** someone pays dollars (USD₮) to a short name like `@ada`, a payment link or a pot. The recipient
  gets naira (cNGN), rupiah (IDRX), Argentine pesos (wARS), Colombian pesos (wCOP) or dollars, in their own wallet.
  The payer chooses, and sees the exact amount before signing. It also works the other way: pay in a local currency
  and the recipient gets dollars.
- **Who checks the limits:** two verified contracts, LokalTags and LokalPots. They refuse an over-limit payment before
  any money moves, and forward an accepted one straight to the agent in the same transaction. They hold nothing.
- **What the agent does:** it reads each payment from Celo, records it before doing anything else, gets a firm
  Textile FX quote, swaps, and pays exactly what the swap delivered. A payment it can't pay goes back to the wallet
  it came from.
- **Where it runs:** the agent runs 24/7 on a cloud server as a system service, with no one at a keyboard. Its
  heartbeat is public: [`/api/status?agent=1`](https://lokalpay.vercel.app/api/status?agent=1).
- **Every transaction is tagged:** the ERC-8021 attribution tag `celo_7360953d1b53` is on every transaction the
  agent sends and every one the site asks a wallet to send.

---

## Check the onchain proof

Nothing to install.

### 1. The first real user: Alvo, Lagos

A loan was repaid to Alvo through LokalPay, to his own tag `@alvo`: **$4 as ₦5,811.35** (converted on Textile FX)
and **$15 in dollars**. Both were paid to his tag through the LokalTags contract, and the agent paid them out on its
own. He agreed to be named.

Open the receipt: [NP-B50B-488C](https://lokalpay.vercel.app/receipt.html#NP-B50B-488C). It is rebuilt live from
the chain, not from our records. Behind it are three agent transactions, each ending with the attribution tag:

| Step | Transaction | What you should see |
|---|---|---|
| Approve | [0xb417…1830](https://celoscan.io/tx/0xb417c8cc2c7760e80a0df95af775611b5e8cd047fc6e031d9c57524008471830) | The agent approves exactly 4 USD₮ to the Textile FX reactor `0xa9AA…35b3`, no more |
| Swap | [0x9f23…3c1e](https://celoscan.io/tx/0x9f23a164400089c688164b5ac61faaec6425ed1673fc245432d93725790c3b1e) | 4 USD₮ out, cNGN in, through the Textile FX reactor |
| Payout | [0xb50b…582a](https://celoscan.io/tx/0xb50b488c1e54ddbf51fa70e24c817273676f27ae408f5aaaff39eff4c6fd582a) | 5,811.34776 cNGN from the agent to Alvo's wallet `0x6bD6…0eD0` |

The $15 in dollars: [NP-FFF1-C937](https://lokalpay.vercel.app/receipt.html#NP-FFF1-C937), payout
[0xfff1…9205](https://celoscan.io/tx/0xfff1c9376bc0836a49125b1933e24ce0e785b60012572400f397902af3d29205).

To check the tag yourself, paste any of these hashes into [Verify](https://lokalpay.vercel.app/verify.html). It reads
the transaction from Celo and shows `celo_7360953d1b53` at the end of its input data.

### 2. All four currencies, both directions (team test)

On 23 November the builder paid $20 to a tag through LokalTags, in all four currencies, then paid all four back to
dollars: eight tagged Textile FX conversions, each paid out by the agent on its own. These are **labelled as team
tests** everywhere, including on the Proof page, and are not counted as users.

| Direction | Receipts |
|---|---|
| USD₮ → naira, rupiah, Argentine peso, Colombian peso | [NP-EF99-2C95](https://lokalpay.vercel.app/receipt.html#NP-EF99-2C95) · [NP-E8A2-959C](https://lokalpay.vercel.app/receipt.html#NP-E8A2-959C) · [NP-6AB5-87F9](https://lokalpay.vercel.app/receipt.html#NP-6AB5-87F9) · [NP-602D-CA67](https://lokalpay.vercel.app/receipt.html#NP-602D-CA67) |
| Each currency → USD₮ | [NP-F09B-0274](https://lokalpay.vercel.app/receipt.html#NP-F09B-0274) · [NP-1361-7AB3](https://lokalpay.vercel.app/receipt.html#NP-1361-7AB3) · [NP-D80E-D9FD](https://lokalpay.vercel.app/receipt.html#NP-D80E-D9FD) · [NP-E3F0-6491](https://lokalpay.vercel.app/receipt.html#NP-E3F0-6491) |

Two more team tests on 24 November ($15 in dollars and ₦5,811 back to dollars) are on the Proof page under team tests.

### 3. The contracts

| Contract | Address | What to look at |
|---|---|---|
| LokalTags (tags and payments) | [`0xFF2f…7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187) | Source verified, [exact match on Sourcify](https://repo.sourcify.dev/42220/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187). Its USD₮ balance is 0: it forwards every payment in the same transaction |
| LokalPots (one link, many payers) | [`0x60F7…7DAF`](https://celoscan.io/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF) | Source verified, [exact match on Sourcify](https://repo.sourcify.dev/42220/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF). Also holds 0 |
| Admin handover | [accepted tx](https://celoscan.io/tx/0xbee2dd85e15c4fb664397f06e1a0a932214c6c6a65aaa3aa99e599905c2ec3a6) | The contracts' admin is a separate wallet from the agent, handed over in two steps |
| First tag claimed | [claim tx](https://celoscan.io/tx/0x4ae77beb9f14d14a1c39525e617a0d6cc50fd08fab68d07a2f3106c8f5e0aeec) | A tag claimed through LokalTags |

### 4. The agent's identity and its status

- [ERC-8004 agentId 10079](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=10079), named
  "LokalPay": [register tx](https://celoscan.io/tx/0x080d54275f02a722a3b0daa408f02a1af760e29f9e39092a9a48d22b964cf62e) ·
  [card update tx](https://celoscan.io/tx/0x089fcfc3ef04a5ae2fcb4c016f11d37c7955bd4e86bc32fae18eaa1732c1b327).
- The agent wallet: [`0x8a69…7a1e`](https://celoscan.io/address/0x8a695cf54CB44753c8b784EB36d266f748617a1e).
- [Live status](https://lokalpay.vercel.app/api/status?agent=1): `ageSec` is how many seconds since the agent last
  checked in (normally under a few minutes), `lagBlocks` is how far behind the chain head it is, `celoBalance` is its
  gas, and `autoRefund: true` means refused payments go back by themselves.
- [Live rates](https://lokalpay.vercel.app/api/rate): Textile FX's current rate for each currency, and the most
  Textile will quote for each.
- A summary for automated checks: [llms.txt](https://lokalpay.vercel.app/llms.txt).

---

## Try the website

No money is needed to see every screen up to the signature.

1. Open [lokalpay.vercel.app](https://lokalpay.vercel.app) and type an amount into the converter. You see what someone
   gets in naira, rupiah and pesos at Textile FX's live rate.
2. Open a tag's page: [lokalpay.vercel.app/@deekamix](https://lokalpay.vercel.app/@deekamix). Pick what they receive
   with **They receive: … · Change**, type an amount, and open **Who am I paying?**: the tag's age, payments it has
   received and its owner. Stop before signing. A real payment of $1 to $25 works the same way as the receipts above.
3. Try a payment over $25: it is refused before your wallet is asked to sign. If you send one from a script anyway,
   the contract reverts it and nothing moves.
4. Press **Get started**, connect a Celo wallet (MetaMask or MiniPay) and sign a free message: no email, no password.
   You get a private dashboard with your tag, money received, links, pots and a notification bell.
5. Open the [Proof page](https://lokalpay.vercel.app/proof.html). It lists every real payout, read live from Celo in
   your browser, with team tests shown separately.
6. The [Features page](https://lokalpay.vercel.app/features.html) links to every feature below.

---

## Everything LokalPay has

### Paying

| Feature | What it does | Status |
|---|---|---|
| Pay a tag | Open `/@name`, choose what they receive, see the exact amount, pay from your own wallet with one signature, through LokalTags | **Live**: every mainnet payout so far, including Alvo's |
| USD₮ → naira, rupiah, Argentine peso, Colombian peso | One firm Textile FX quote per payout | **Live**: all four ([section 2](#2-all-four-currencies-both-directions-team-test)) |
| Naira, rupiah and pesos → USD₮ | Pay in a local currency, the recipient gets dollars | **Live**: all four (team test) |
| Dollars straight through | The recipient chooses dollars; no conversion | **Live**: Alvo's $15 |
| Get a quote | A free live Textile FX price for every currency, no wallet needed | **Live** on the site |
| Pay a link | Pay the exact amount someone asked for, in one step | **Built and tested** |
| Pay a pot | Spray into a wedding, birthday or group-gift pot through LokalPots | **Built and tested** (LokalPots is deployed and verified) |
| `lokal` command line | `lokal send ada 10 --to rupiah` from PowerShell. An encrypted wallet on your own PC, `--dry-run` shows the exact transaction and sends nothing, `--wait` prints the receipt number. One-line installer | **Built and tested** |
| Pay from CELO (operator) | The agent turns CELO into dollars, then naira (two Textile quotes), keeping a CELO reserve for gas | **Built and tested**, operator only. On the site it is listed as coming soon |

### Getting paid

| Feature | What it does | Status |
|---|---|---|
| Claim a tag | A short name like `@ada` that pays your own wallet, claimed through LokalTags. Reserved names (admin, support, celo, minipay and others) can't be taken | **Live**: tags claimed on mainnet |
| Sign in with your wallet | Connect, sign a free message. No email, no password | **Live** on the site |
| Choose what you receive | Naira, rupiah, pesos or dollars; the payer can still change it per payment | **Live** |
| Get paid links | Ask for an exact amount in the currency you want, by link, with a QR code only when you want one. One link, one payout | **Built and tested** |
| Pots and the Spray Wall | One link and QR code for many guests, a live wall of who sprayed, a goal and a closing time. The host can close or delete a pot | **Built and tested** |
| Private dashboard | Your tag, money received, your links and pots, and a notification bell. Visitors never see anyone's activity | **Live** on the site |
| Your activity and CSV export | Every payment you sent or received with LokalPay, with its receipt and tag | **Live** on the site |
| Add the token to your wallet | One button so cNGN, IDRX, wARS or wCOP shows up in your wallet | **Live** on the site |
| Cash-out guide | A checked route from each currency to a bank | **Live** on the site ([cash-out](https://lokalpay.vercel.app/cash-out.html)) |

### Trust and proof

| Feature | What it does | Status |
|---|---|---|
| Contract limits | LokalTags and LokalPots refuse over-limit payments before money moves | **Live** |
| "Who am I paying?" | Above Pay on every tag page: the tag's age, payments received and the owner. Warnings only when they apply: first-time payee, new tag (24 h), changed hands (30 days), lookalike (one edit from a tag you paid, or a reserved name), name changed (7 days). None blocks payment | **Live** on the site |
| Receipts | Every payout gets a number (`NP-` plus the first 8 characters of the payout hash), rebuilt from Celo in the browser. Save as image or PDF, share on WhatsApp or by QR code | **Live**: 12 receipts |
| Proof page | Every real payout, read live from Celo, with team tests shown separately | **Live** |
| Verify | Paste any Celo transaction to see its attribution tag | **Live** |
| Refunds | A payment the agent can't pay goes back to the exact wallet it came from, with an `RF-` receipt. Automatic on the server (`--auto-refund`), at most 3 per payer per 24 h | **Built and tested**, switched on. No payment has needed one yet |
| Ratings | From a receipt, the payer rates the payout 1 to 5 stars on the ERC-8004 Reputation Registry, from their own wallet. The Agent page lists them, marking verified payers | **Built and tested** |
| ERC-8004 identity | agentId 10079, "LokalPay" | **Live** |
| Attribution tag | `celo_7360953d1b53` on every transaction | **Live**: on all of them |

### The agent and how it is run

| Feature | What it does | Status |
|---|---|---|
| Autopilot | Watches LokalTags, LokalPots and payment links every 15 seconds, records each payment, then pays it | **Live**: paid every mainnet payout |
| 24/7 server | A Linux system service that restarts after a crash. A checked move from the PC: the PC is sealed so two agents can never run | **Live** ([SERVER.md](docs/SERVER.md)) |
| Public heartbeat | `/api/status?agent=1`. Pay pages show "agent offline" if it stops checking in | **Live** |
| One agent at a time | A lock file shared by every command that can move money | **Live** |
| Safety stops | If something unexpected happens (a payout fails, a swap brings nothing, a tag is missing) the agent stops on purpose, records why, and stays stopped until a person checks | **Built and tested** (none has happened on the server) |
| Plain-English payments (`ask`) | `ask "send $10 to ada"` turns into a payment to an allow-listed contact. It works without any AI key; with one, a language model reads looser phrasing. The model only ever returns a name and a number, and the code enforces every limit | **Built and tested**, command line only |
| Payment requests | The operator creates a request for an exact amount that expires (48 h by default) | **Built and tested** |
| Alerts | Telegram or webhook messages for payouts, refusals, low gas and stops | **Built and tested** |
| `doctor` | Checks the agent's setup, keys, gas and connections in one command | **Built and tested** |
| Low-gas warning | Warns when the agent holds less than 3 CELO. It holds about 14 CELO now | **Live** |
| ERC-8004 registration | `register` writes the agent's card onchain | **Live**: agentId 10079 |

### Planned

- **MiniPay mode:** claim a tag and get paid without leaving MiniPay.
- **Pay with CELO** for payers on the site.
- **Pay for me:** a link with a title and a note, so someone else can pay it for you.
- **Dollar subscriptions paid in local money:** naira → dollars on Textile FX, paired with a stablecoin-funded virtual
  card for X Premium, ChatGPT and app stores.
- **Direct cash-out partners** per country, and more currencies as Textile FX adds pairs.
- **A small, visible fee**, shown before the payer signs. Today there is no fee and the operator pays the gas.
- **A low-balance hot key** for the agent, with the main funds in a separate wallet.

---

## Safety: every limit and who enforces it

| Rule | Enforced by |
|---|---|
| $1 to $25 per payment, $25 per recipient per day, $25 per payer per day, $250 per day overall (USD₮ on LokalTags) | The LokalTags contract, before money moves |
| Pots: per-payer cap set by the host, $100 per host per day, $250 per day for all pots | The LokalPots contract |
| No paying yourself, no unknown tags, no tokens outside the list | The contracts |
| A new payout wallet waits 24 hours in public before it takes effect, and a payer can pin the one they expect | The contracts |
| The admin is a separate wallet from the agent | The contracts (two-step handover, [tx](https://celoscan.io/tx/0xbee2dd85e15c4fb664397f06e1a0a932214c6c6a65aaa3aa99e599905c2ec3a6)) |
| The firm quote may be at most 3% worse than the preview, or nothing is sent | The agent |
| Approvals are exact, to the quote's reactor only, with any old allowance reset first | The agent |
| The recipient gets what the swap actually delivered, never more | The agent |
| Recorded before paid; a rescan never pays twice; a refunded payment is never paid | The agent |
| Refunds only to the wallet that paid, never to the agent's own wallets or contracts | The agent |
| The agent never pays itself, its own wallets, token or registry contracts, or the zero address | The agent |
| Every transaction carries the attribution tag; an untagged one stops the agent | The agent |

Full list: [docs/WHO-ENFORCES-WHAT.md](docs/WHO-ENFORCES-WHAT.md).

---

## Run the tests

Node.js 20 or newer.

```bash
git clone https://github.com/deeeko/lokal.git
cd lokal
npm ci
npm test                          # 421 tests, no network needed
cd contracts && npm ci
npx hardhat test                  # 135 contract tests
npm run demo                      # both contracts on a local chain, 28 payments, every outcome asserted
```

Both suites run on every push ([CI](https://github.com/deeeko/lokal/actions/workflows/ci.yml),
[contracts](https://github.com/deeeko/lokal/actions/workflows/contracts.yml)). The ones worth a look:

| File | What it proves |
|---|---|
| `test/invariants.test.mjs` | Twelve rules that must always hold: dry run by default, record before pay, exactly once, exact approvals, 3% slippage, the caps, paying what the swap delivered, blocked recipients, the attribution tag, and never paying an ambiguous deposit automatically |
| `test/refund.test.mjs` | Refunds only to the sending wallet, never twice, never for a paid deposit, and safe after a crash |
| `test/reverse-corridors.test.mjs` | Local currency back to dollars |
| `contracts/tests/LokalTags.spec.ts`, `LokalPots.spec.ts` | Every limit, every refusal, the 24-hour payout wallet delay |
| `contracts/tests/Attack.spec.ts` | Re-entry through token hooks, and tokens that lie about transfers, all refused |
| `contracts/tests/SiteCalldata.spec.ts` | The exact transactions the website builds, replayed against the real contracts, each with the attribution tag |
| `contracts/tests/RulesParity.spec.ts` | The contract, the site and the agent agree on which tags and names are valid (thousands of random cases) |

---

## The judging criteria

### Execution

- Working on Celo mainnet, not a mock: two verified contracts, a 24/7 agent, real Textile FX swaps in all four
  currencies and both directions, and receipts rebuilt from chain data.
- Built so a mistake can't lose money: the contracts refuse over-limit payments before money moves, every payment is
  recorded before it is paid, the firm quote must be within 3% of the preview, approvals are exact, and a refund can
  only go back to the wallet that paid.
- 421 tests and 135 contract tests, on every push.

### Value proposition

- **For recipients:** local money in their own wallet, in seconds, at a rate they can see first, paid to a short name
  instead of a 42-character address. The cash-out guide shows the route to a bank.
- **For payers:** pay from your own wallet, see exactly what arrives, and see who you're paying before you sign.
- **For groups:** a pot (weddings, birthdays, group gifts) gives many guests one link and a live Spray Wall.

### Onchain traction

- A named real user, Alvo in Lagos, paid in naira and dollars: [NP-B50B-488C](https://lokalpay.vercel.app/receipt.html#NP-B50B-488C),
  [NP-FFF1-C937](https://lokalpay.vercel.app/receipt.html#NP-FFF1-C937).
- 12 payouts on mainnet, all through LokalTags and all paid by the agent on its own. Ten are labelled team tests.
- Every transaction tagged with `celo_7360953d1b53`.

### A named user with a real job done

Alvo was owed money; it was repaid to him through LokalPay, part in naira and part in dollars, to his own wallet.

---

## Track 3 requirements

| Requirement | Status |
|---|---|
| Tagged Textile FX conversion on Celo mainnet, in a listed corridor, in the product flow | Done: USD₮ → cNGN for Alvo, [swap 0x9f23…3c1e](https://celoscan.io/tx/0x9f23a164400089c688164b5ac61faaec6425ed1673fc245432d93725790c3b1e). Plus IDRX, wARS, wCOP and all four back to USD₮ (team tests) |
| Local-stablecoin payment to a recipient outside the team | Done: 5,811.35 cNGN to Alvo, [payout 0xb50b…582a](https://celoscan.io/tx/0xb50b488c1e54ddbf51fa70e24c817273676f27ae408f5aaaff39eff4c6fd582a) |
| ERC-8004 identity | Done: [agentId 10079](https://celoscan.io/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=10079) |
| A named user with a real job done | Done: Alvo, Lagos, a loan repaid |

---

## Where to look in the code

| Claim | Where |
|---|---|
| The limits, checked before money moves | `contracts/contracts/LokalTags.sol`, `contracts/contracts/LokalPots.sol` |
| Reading payments from Celo, record before paying | `src/watch.mjs` (`runWatch`, `classifyNtagDeposit`), `src/contract-watch.mjs` |
| Quote, approve, swap and payout | `src/pay.mjs` (the flow), `src/textile.mjs` (the Textile FX RFQ client) |
| Finishing a payout whose swap went through | `src/settle.mjs` (pays what the recorded swap delivered, never swaps again) |
| The agent's own caps and blocked recipients | `src/guards.mjs`, `src/config.mjs` |
| Refunds | `src/refund.mjs` (`planRefund`, `executeRefund`) |
| One agent at a time, and safety stops | `src/lock.mjs`, `src/safety-stop.mjs` |
| Attribution tag on every transaction | `src/chain.mjs` (added once, where the wallet client is built) |
| Plain-English payments | `src/intent.mjs` |
| "Who am I paying?" | `site/assets/trust.js` |
| The public status and rate endpoints | `api/status.js`, `api/rate.js` |
| Running 24/7 on a server | [docs/SERVER.md](docs/SERVER.md), `scripts/server/` |
| How it all fits together | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

---

## What is not done yet

Said plainly, so nothing is a surprise:

- **One real user so far.** Alvo is the first. Anyone can claim a tag on the live site and be paid.
- **Pots, payment links, refunds and ratings haven't had real money through them yet.** They are built, tested
  against the real contracts and live on the site.
- **Cashing out to a bank is a separate step.** The recipient moves the local stablecoin to an exchange that lists it
  and withdraws from there. The [cash-out guide](https://lokalpay.vercel.app/cash-out.html) lists a route per currency.
- **Colombian peso liquidity is thin.** Textile FX currently quotes only a few dollars at a time for wCOP; the live
  limit is `maxUsd.wcop` in [`/api/rate`](https://lokalpay.vercel.app/api/rate).
- **The agent holds a payment while it converts it.** Only for the seconds between the contract forwarding it and the
  payout; the contracts themselves hold nothing.
