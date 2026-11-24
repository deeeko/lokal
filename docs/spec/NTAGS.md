> **Legacy wire format.** This is the original spec for LokalPay tags (first called "nTags"): the `NT1:` claim and
> `NTP:` memo formats. Since block 83,405,000 new claims go to the LokalTags contract; `NTP:` memo payments to tags
> claimed before then are still paid, which is why this format is kept and documented. See docs/WHO-ENFORCES-WHAT.md.

# nTags (LokalPay tags): legacy spec, 21 Nov 2026

nTags are human handles (`@ada`) tied to a Celo wallet, plus wallet sign-in for the site. Anyone can pay an nTag in
USD₮ (or cNGN) and the agent pays the tag owner's wallet in cNGN (or USD₮). Non-custodial: the site never holds keys or
funds; the agent only converts and forwards a single deposit, under the same caps as every other payout.

## 1. Protocol (MUST be identical in site/assets/core.js and src/ntags.mjs; a test cross-checks them like registrations)

### 1a. Claim / release (an "nTag op")
A successful (`status ok`) zero-value tx FROM the wallet TO the agent (`0x8a695cf54CB44753c8b784EB36d266f748617a1e`)
whose input is `hex(utf8("NT1:" + JSON))` + optional ERC-8021 suffix (the site always appends `tagSuffix()`, the same
attribution suffix registrations use; decoding strips any ERC-8021 suffix exactly like `decodeRegistration`).
- Claim: `{"t":"ada"}` or `{"t":"ada","n":"Ada Obi"}` (n = optional display name, 1–40 chars after trim, no control chars).
- Release: `{"t":""}` — releases the sender's current tag (no-op if none).
- Any other shape / extra keys / non-string fields → invalid → ignored. Tx value must be 0 (non-zero value → ignored).

### 1b. Tag rules — `ntagError(t)` returns error string or null
- `^[a-z][a-z0-9_]{2,19}$` (3–20 chars, lowercase, starts with a letter), no `__`, must not end with `_`.
- Input normalisation for UI/CLI only (`normalizeNtag`): trim, strip one leading `@`, lowercase. The onchain JSON must
  already be normalised; a claim with uppercase is INVALID (not normalised by the resolver).
- Reserved (cannot be claimed by anyone): agent, admin, administrator, root, system, support, help, official, team,
  staff, mod, moderator, security, celo, minipay, valora, opera, textile, naira, nairapayout, payout, payouts, ntag,
  ntags, lokal, lokalpay, cngn, usdt, usdc, tether, cusd, ceur, wallet, bank, cbn, null, undefined, anonymous, everyone, me, you,
  test, demo, api, www, app, pay, send, receive.

### 1c. Resolution — `resolveNtags(ops, atSec = Infinity)` (pure, deterministic)
ops: `{ hash, from, block, position, time (sec), value?, op }` where op is the decoded JSON. Process VALID ops in
(block, position) order, only those with `time <= atSec` (and for deposit resolution: strictly before the deposit
in (block, position) order — expose `resolveNtagsBefore(ops, block, position)`).
State: `owner: Map<tag, {owner, name, since(sec), hash}>`, `byOwner: Map<lowercase address, tag>`,
`lock: Map<tag, {owner, until}>`.
- Sender is the agent address → ignore.
- Claim t:
  - t already owned by sender → only update the display name (if n given) — no-op otherwise.
  - t owned by someone else → ignored (status "taken").
  - t locked (released < 30 days ago, `RELEASE_LOCK_DAYS = 30`) and sender ≠ the lock's previous owner → ignored ("locked").
  - otherwise: if sender owns another tag, that tag is released (lock it for 30 days for the sender) then sender gets t.
- Release: sender's tag (if any) is released and locked for 30 days for its previous owner.
Return `{ tags: Map, byOwner: Map, locks: Map, statuses: Map<hash, "claimed"|"renamed"|"released"|"taken"|"locked"|"reserved"|"invalid"|"noop"> }`.
Helpers: `ntagOf(state, address)`, `ownerOf(state, tag)`, `ntagAvailability(state, tag, forAddress, nowSec)` →
`"invalid"|"reserved"|"yours"|"taken"|"locked"|"free"`.

### 1d. Discovery
Every nTag op ever sent to the agent: paginate Blockscout `/addresses/<agent>/transactions?filter=to` (newest first)
to the END (tags are permanent; no time window), max 200 pages, then throw (never return a partial list). Site:
`loadNtagOps()` in core.js (uses EXPLORER_API + getJson like loadRegistrations; may cache the result in memory for 30 s).
Agent: `discoverNtagOps({ agent, api, fetchImpl })` in src/ntags.mjs. Item → op exactly like `registrationFromItem`
(+ value from `t.value`). Registrations (NP1:) and nTag ops (NT1:) never collide (different prefix).

### 1e. Paying an nTag (the "tag memo")
The payer sends an ordinary ERC-20 `transfer(agent, amount)` on USD₮ or cNGN, with extra bytes appended to calldata:
`0xa9059cbb` + 32-byte agent + 32-byte amount + `hex(utf8("NTP:" + tag))` + optional ERC-8021 suffix (site appends
tagSuffix()). Token contracts ignore trailing calldata (the agent's own txs already carry a suffix the same way).
- `encodeNtagTransfer(agent, amountUnits(bigint), tag)` → calldata; `decodeNtagMemo(input)` → tag or null: strip
  ERC-8021 suffix, require selector a9059cbb, skip 4+32+32 bytes, the remainder must be exactly `"NTP:" + tag` with a
  valid tag (ntagError null) — else null.
- Currency (multi-currency, 22 Nov): the memo may name what the owner receives, `"NTP:" + tag + ":" + code` with code
  in `NTAG_CURRENCIES` (`cngn` | `idrx` | `wars` | `wcop`). `encodeNtagTransfer(agent, units, tag, currency?)` writes
  the code (naira / no currency keeps the original `"NTP:" + tag` bytes); `decodeNtagPayment(input)` → `{ tag,
  currency (null = naira) }` or null (an unknown or empty code is not a valid memo: autopilot refuses it as a bad memo).
- Corridor by token and memo: USD₮ deposit → `usdt-<code>` (no code: `usdt-cngn`, naira); cNGN deposit → `cngn-usdt`
  (owner gets dollars; a cNGN deposit naming a currency is refused). A currency Textile isn't quoting at payout time is
  refused with `currency_unavailable` and never paid in another currency.
- Preferred currency: a claim may carry `c`, `{"t":"ada","c":"idrx"}` (also on its own, from the owner: status
  "updated"). Resolved like names; the entry gets `currency`. Pay pages pre-select it; the memo decides what is paid.
- Amount limits: USD₮ $1.00–$25.00 (USDT 6 decimals, ≤ 2 decimals is NOT required for deposits — any amount within
  limits is OK; the agent pays the whole deposit); cNGN up to the $25 cap in value (agent's guards enforce).

## 2. Agent (src/)

- `src/ntags.mjs`: the ports above + `discoverNtagOps` + `verifyNtagOpOnchain(pub, op, agent)` (re-read the WINNING
  claim tx over RPC: success, to agent, same from, same block/position, same decoded op, value 0 → else permanent refusal)
  + local state `ntag-payments.json` (git-ignored; config `NTAG_PAYMENTS_FILE`), keyed by `${tx}:${logIndex}`, atomic
  write like saveRegState.
- `src/watch.mjs`: in `handle(l)`, when fetching the tx for `txFrom`, also keep its `input`. If `decodeNtagMemo(input)`
  returns a tag, the deposit is an nTag payment and is NEVER matched against requests/registrations (memo wins):
  - already recorded in ntag-payments.json → skip ("already handled").
  - resolve with ops discovered this poll (discover every poll, like registrations; deposits are only scanned up to
    Blockscout's indexed height, so ops are complete) using `resolveNtagsBefore(ops, depositBlock, depositPosition)`
    (position = the deposit tx's transactionIndex).
  - unknown / unowned tag → refused: logged `{type:"refused_deposit", reason:"unknown nTag", ...}`, not paid, continue.
  - owner found → `verifyNtagOpOnchain` on the owner's winning claim, then `preflight({ to: "@"+tag, amount, corridor,
    agent, recipientAddress: owner, payer })` (same recipient rules + caps as registrations: payer ≠ recipient, not the
    agent/own wallets/blocked/contract; per-payout and per-wallet caps are permanent refusals → log and continue;
    global daily cap / price failures → StopError with the cursor pinned, exactly like handleRegistration).
  - record the deposit in ntag-payments.json BEFORE paying; then `pay({ to: "@"+tag, amount, corridor,
    recipientAddress: owner, payer, execute: true, yes: true, ntag: tag })`; store paidAt/hashes/receiptNo; failures
    recorded + StopError with retry instructions (`node src/agent.mjs retry --ntag <tx>:<logIndex>`).
  - dry-run mode mirrors handleRegistration (nothing written).
  - amount string: deposit value formatted with 6-decimal precision trimmed (check what pay() accepts; if pay requires
    ≤2 decimals, pay the deposit rounded DOWN to the cent and log the dust — never pay more than received).
- `src/agent.mjs` new commands (and help text): `ntag <tag|address>` (lookup: owner, name, since, claim tx, status),
  `ntags` (list all current tags), `pay @tag <amount> [--corridor ...] [--execute]` (owner payout from the agent's own
  funds to the tag owner's wallet: resolve now, verify claim onchain, then the existing recipientAddress pay path —
  caps apply; dry run unless --execute), `ntag-data @tag <amount> [--token usdt|cngn]` (prints the to/data a user can
  send from their OWN wallet/CLI to pay a tag — never asks for a key), `retry --ntag <tx>:<logIndex>`.
- `src/config.mjs`: `NTAG_PAYMENTS_FILE`. `.gitignore`: `ntag-payments.json`.
- Tests: `test/ntags.test.mjs` — rules, reserved, normalisation, encode/decode round-trips (with & without suffix,
  wrong selector, junk), resolution (claim, taken, rename, switch tag releases old + lock, release lock, owner re-claim
  within lock, reserved, agent sender ignored, ordering by block/position, resolveNtagsBefore), and a cross-check that
  core.js and src/ntags.mjs produce identical results on a shared fixture set (import core.js the way
  test/registrations.test.mjs / core-codec.test.mjs already do). Watch integration tests with fakes if feasible.

## 3. Sign-in (wallet login)

- "Sign in" = connect wallet + sign a free EIP-4361 (SIWE-style) message via `personal_sign`. No password, no gas.
  Message: `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Naira Payout. This is free and sends nothing.\n\nURI: ${origin}\nVersion: 1\nChain ID: 42220\nNonce: ${16 random hex}\nIssued At: ${iso}\nExpiration Time: ${iso + 7 days}`.
- Session = `{ address, message, signature, exp }` in localStorage key `np-session` (try/catch all storage).
  Valid while not expired AND (if a wallet is injected) the wallet's current `eth_accounts[0]` matches; otherwise the
  UI shows "signed out" (keeps disconnect semantics: Sign out = clear session + `disconnectWallet`).
- Server check (Vercel only, `HAS_API`): `api/session.js` POST `{message, signature}` → verifies with viem
  `verifyMessage` (EOA) AND parses address/expiry/chain/URI host from the message (host must equal the request Host
  header or naira-payout.vercel.app / celo-naira-payout-agent.vercel.app); returns `{ok, address, exp}` or 400. No
  cookies, no DB, stateless, max body 4 KB, POST only, JSON only. Test in test/vercel-api.test.mjs style. Off Vercel
  (GitHub Pages/local), the signature is accepted client-side (document this honestly in privacy/docs).
- Shared module `site/assets/session.js` (ES module, imported by pages): `getSession()`, `signIn(eth)`, `signOut(eth)`,
  `onSessionChange(cb)`, `ensureCelo(eth)` (move/copy the get-paid helper), `explainWalletError(e)`.

## 4. Site UX

### Pages
- `index.html` (landing): the hero becomes the front door: "Sign in with your wallet" (primary) and "Find an nTag"
  (inline search: type `@ada` → live owner lookup → "Pay @ada"). Signed in → hero swaps to a personal greeting with the
  user's tag card (or a nudge to claim one) and "Go to your account". Keep the live stats/quote/activity below.
- `account.html` (new, "Account"): requires sign-in (shows a polished sign-in panel otherwise). Sections:
  1. Your nTag — if none: the CLAIM flow (below). If owned: the tag card, share link (`/@tag` on Vercel, `tag.html#tag`
     elsewhere), QR, WhatsApp share, change tag, release tag (with lock warning).
  2. Wallet — address, network, USD₮/cNGN/CELO balances (RPC balanceOf), sign out.
  3. Payments to your tag — deposits to the agent whose memo is your tag + the agent's payouts to your wallet (from
     Blockscout token transfers), with receipt links when paid.
- `tag.html` (new, public profile + pay page; `#ada` or `?t=ada`; Vercel rewrite `/@:tag` → `/tag.html?t=:tag`):
  tag card (name, @tag, short owner address with Celoscan link, "since"), and the Pay flow: choose "They get naira" (you
  send USD₮) or "They get dollars" (you send cNGN), amount with live estimate (loadRate), limits ($1–$25), connect,
  balance check, payer ≠ owner check, then one `eth_sendTransaction` to the TOKEN contract with
  `encodeNtagTransfer` data. Then: confirmation tracking (receipt poll), then "The agent pays @ada when autopilot runs"
  and poll Blockscout for the agent's payout to the owner after the deposit time → show "Paid · NP-XXXX-XXXX" with
  receipt link. Unknown tag → friendly empty state with "Claim @ada yourself" CTA.
- Sidebar (every page): add "Account" (Product group, top) and "nTags" is reached via Account; sb-foot gets a user chip:
  generated avatar (deterministic gradient from address, CSS only), `@tag` or short address, "Sign in" when signed
  out. Mobile top bar: a compact sign-in / avatar button. Footer Product lists get Account.
- docs.html: an nTags section (claim, pay, CLI commands, rules, lock, privacy: tags and names are public & permanent).
  privacy.html: wallet sign-in signature + localStorage session; tags public onchain. README: nTags section.

### Claim flow (the showpiece) — account.html
Stepper with 4 states, each animated in place (no page reloads):
1. Pick your tag: big input with a fixed `@` prefix, set in the display face; availability checked live (debounced
   250 ms against the cached ops: free / yours / taken / reserved / locked / invalid with the exact rule broken);
   3 smart suggestions when taken (name-based: ada → ada_ng, adaobi, ada01 style, all verified free).
   Optional display name. Live preview of the TAG CARD updating as you type.
2. Review: public & permanent notice (tags and names are onchain forever) + checkbox.
3. Claim: one tx (`to: AGENT, value 0x0, data: encodeNtagClaim({t,n})`), with wallet → Celo confirm progress.
   Then re-resolve after Blockscout indexes it (poll up to ~2 min) and confirm the tag is yours (handle "someone
   claimed it a moment earlier" → explain and offer suggestions).
4. Done: celebration moment — the tag card "stamps"/flips into its final state; share buttons, QR, link.

### Signature element: the nTag card
A physical-feeling card, roughly credit-card ratio: deep green-black glass, `@tag` set big in Sentient italic (the
display face already in assets/fonts), owner name in General Sans, short address in mono, small Celo-ish ring mark,
and a subtle holographic sheen in Celo yellow (#fcff52) → mint green that follows the pointer (CSS custom props set by
pointermove; 3D tilt ≤ 8°). Respect `prefers-reduced-motion` (no tilt/sheen animation). Keyboard focus visible.
Everything else stays quiet and consistent with the existing design system (styles.css tokens, .card, .btn, .field,
.badge, .alert, .kv-list, sidebar). New CSS goes in `site/assets/ntags.css` (linked by index/account/tag pages) —
styles.css only for the sidebar user chip / nav item if needed.

### Quality floor
No new external hosts, no inline scripts (CSP), DOM building via core.js `el()` (no innerHTML with data), all copy in
plain sentence case, works at 360 px wide (no horizontal scroll), focus-visible, aria-live for async status, reduced
motion respected, older-browser fallbacks like the existing code (no AbortSignal.timeout / .at()). check-site.mjs must
pass (update it if it enumerates pages). Every page keeps the same chrome (sidebar, mobile top bar, footer, consent).

## 5. The LokalTags contract and the cutover (21 Nov 2026)

Tags and payments now go through the contracts: LokalTags `0xFF2f8ADC0c97B6E40b201848d378C11325bC7187` and LokalPots
`0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF` (Celo mainnet, Sourcify exact match; admin a separate owner wallet; payout
wallet = the agent `0x8a695cf54CB44753c8b784EB36d266f748617a1e`). Shared code: `site/assets/lokal-contracts.js`
(site and `lokal` CLI) and `src/contract-watch.mjs` (autopilot).

### 5a. Calls (every one with this app's ERC-8021 suffix appended; Solidity ignores the trailing bytes)
- Claim: `claim(tag, name)` ("" = no name). Claiming another tag releases the current one.
- Rename: `setName(name)` ("" removes it). Default currency (optional): `setReceiveToken(token)` (zero = none).
- Release: `release()`.
- Pay: USD₮ `payTagWithPermit(tag, token, amount, ref, expectedPayout, deadline, v, r, s)` after one EIP-2612 permit
  (domain "Tether USD", version "1", chain 42220, USD₮; exactly `amount`, 30 minutes); other tokens: `approve(LokalTags,
  amount)` then `payTag(tag, token, amount, ref, expectedPayout)`. `expectedPayout` = the agent (pinned).
- Pages simulate each call (`eth_call` from the user's wallet, plus `validatePayment`) and show the revert in plain
  English before the wallet opens. Reads: `tagInfo`, `tagOf`, `availability`, `remainingToday`, `tokenLimits`.

### 5b. The payer's currency: `ref` = "cur:<code>"
The payer chooses what the recipient gets on each payment. `bytes32 ref` = the ASCII text `cur:` + code (`cngn`, `idrx`,
`wars`, `wcop`, or `usdt` for dollars), left-aligned, zero-padded to 32 bytes (rupiah: `0x6375723a69647278` + 24 zero
bytes). Any other ref names no currency. The agent pays: the ref's choice, else the recipient's default
(`receiveTokenOf` at the payment's block), else naira for USD₮ and dollars for cNGN (pots: dollars). USD₮ -> local via
`usdt-<code>`, cNGN -> dollars via `cngn-usdt`, a payment already in the chosen token passed on as is; any other pair is
refused (never paid in another currency). Nobody has to pick a currency to sign up.

### 5c. Autopilot
`TagPaid` / `PotPaid` via `eth_getLogs` over the same range and cursor as deposits. The inner Transfer (payer -> agent,
exact amount, just before the event) is the payment and is removed from the deposit path. Same safety path, recorded in
`contract-payments.json` before paying, exactly once per event key (`tx:logIndex` of the event). Refusals are recorded
and refundable to the payer by the inner Transfer's key (`refund --deposit <tx>:<logIndex>`).

### 5d. Cutover (block 83,405,000, about 22 Nov 2026 00:00 UTC)
Counted first (Blockscout, the agent's discovery code, read-only): 1 legacy `NT1:` claim (@deekamix, block 83,355,505),
0 `NTP:` memo payments, 0 contract claims or payments.
- New claims go to the contract only: `NT1:` ops in the cutover block or later are ignored (`legacyNtagOps`).
- Legacy `NTP:` memo payments to legacy tags keep being paid to their legacy holder.
- A name held in both places: the contract owner wins. From the cutover block, an `NTP:` memo to a tag held on
  LokalTags pays the contract's holder at that block; the site and CLI show the contract's holder.
- The formats `NT1:`, `NTP:`, `NP1:`, `NP-` receipts and the sign-in text are frozen and unchanged.
- `LEGACY_CUTOVER_BLOCK` lives in `src/config.mjs` and `site/assets/core.js`; a test keeps them equal.
