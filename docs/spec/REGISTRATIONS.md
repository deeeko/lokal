> **Wire format of "Get paid" registrations (`NP1:`).** Originally written as a build spec next to two earlier specs
> that are no longer kept; the formats below are what `site/assets/core.js` and `src/registrations.mjs` implement.

# Feature contract v2: "Get paid" (own wallet) + Receipt v2

## A. "Get paid" — a recipient registers their own payment request onchain

### Registration transaction (made by the RECIPIENT's wallet, in the browser)
`eth_sendTransaction { from: <recipient>, to: AGENT, value: "0x0", data: "0x" + hex(utf8("NP1:" + JSON)) + tagSuffix() }`
JSON (compact, validated on both sides):
`{ "a": "5.03", "d": "usdt-cngn" | "cngn-usdt", "e": <expiry unix SECONDS>, "n": "<display name, 1-40 chars>", "m": "<optional note, <=80 chars>" }`
- The recipient is `tx.from` — proven by the signature, so it can't be mistyped or faked.
- `a` has at most 2 decimals; for usdt-cngn 1 <= a <= 24.99; for cngn-usdt the USD value (reverse rate) must be <= $25.
- Expiry: 1 to 168 hours after the block time.
- Request id = the registration tx hash. Link: `pay.html#tx=<registrationHash>`.
- PRIVACY: name, note, amount and wallet become public and permanent onchain. The UI must say so plainly before the
  wallet prompt (and privacy.html gets one line about it).

### Collision rule (agent and site MUST implement identically)
Among VALID, UNEXPIRED registrations (paid or not — the site can't see "paid", so it is deliberately ignored) with the
same corridor and the same exact amount, the EARLIEST (lowest block, then lowest position) is "active"; later ones
are "amount in use" and are never paid. IMPLEMENTED + TESTED in site/assets/core.js: registrationError(),
encodeRegistration(), decodeRegistration(), registrationStatuses(regs, nowSec), loadRegistrations(); and
receiptNo(hash), parseReceiptNo(str). The agent (Node) must replicate these byte-for-byte (import or port them, and
add tests that cross-check against core.js like test/core-codec.test.mjs does). The Get paid page checks registrations
before sending and suggests a free amount (adjust cents) so collisions rarely happen.

### Matching + payout (agent, `watch`)
A deposit (ERC-20 Transfer to AGENT of the sell token) matches the active registration with the exact amount when the
deposit time is >= registration time and < expiry. Then, with --execute and all checks passing, the agent converts
and pays the bought token to `tx.from` of the registration. Rules (all enforced in code, pre-flight before recording):
- payer (deposit `from`) must NOT equal the recipient (no self-payment / wash);
- recipient must not be AGENT, a token/registry contract, the zero address, or one of the owner's own_wallets;
- per-payout $25, rolling 24 h $100 overall (MAX_DAILY_USD), and per recipient wallet rolling 24 h MAX_WALLET_DAILY_USD (default 25);
- one payout per registration; registrations are discovered from transactions TO the agent whose input starts with
  hex("NP1:") (Blockscout `/api/v2/addresses/<AGENT>/transactions?filter=to`, paginated) — failed txs ignored;
- owner-created requests (requests.json / contacts) keep working exactly as before.
Record paid registrations in a local file (registrations-state.json, git-ignored) and log receipts as today.

### Pages
- NEW `site/get-paid.html` + `site/js/get-paid.js`: explainer (who it's for: someone in Nigeria getting paid from
  abroad, or someone getting paid in dollars), "Connect wallet" (window.ethereum; switch/add Celo 0xa4ec), form
  (receive as: naira / dollars; amount; name; note; expiry hours), live estimate, free-amount suggestion, the public-data
  warning, then "Create my link" → wallet prompt → wait for the receipt → show the link `pay.html#tx=…` with copy,
  WhatsApp share and QR. No wallet → instructions for MiniPay / MetaMask mobile (open this page in the wallet browser).
  Needs a little CELO for gas: say so, link to how to get it.
- UPDATE `site/pay.html` / `pay.js`: support `#tx=<hash>` (read the tx via RPC, decode, validate, show "Registered by
  this wallet onchain" with the recipient address, collision status "amount in use" if applicable, then the same live
  status Waiting → Received → Paid out, payout must go to the registration's `from`). `#r=` links keep working.
- Sidebar: the lead adds "Get paid" (Product group) on every page.

## B. Receipt v2

- Receipt number = `NP-` + first 8 hex chars of the PAYOUT tx hash, upper-case, as `NP-XXXX-XXXX`
  (e.g. 0x7f3a91c2… → NP-7F3A-91C2). Deterministic, unique in practice, recomputable by anyone.
- `receipt.html#NP-7F3A-91C2` resolves by scanning the agent's outgoing transactions (paginate Blockscout) for a payout
  whose hash starts with 0x7f3a91c2; if more than one match, list them. Old `#p=…` links keep working.
- Slip layout: big "₦7,250.00 received" (or "$9.98 received"), status "Completed", receipt number, date/time WAT,
  paid by (wallet short; name if the request carries one), paid to (name + wallet short), sent amount, exchange rate,
  fees (from the swap: sold − bought × mid where derivable, else omit), route "Textile FX on Celo", "Verified onchain"
  with the tx links (payout, swap) as proof, attribution tag badge.
- Actions: "Download image" (PNG drawn on a <canvas> at 2x with the self-hosted fonts after document.fonts.ready —
  no external libraries beyond the already-vendored QR), "Save as PDF" (window.print with a clean print stylesheet),
  "Share on WhatsApp" (text with receipt number + amount + link), "Copy link". A QR on the slip encodes the receipt URL.
- Agent CLI: after every executed payout print `Receipt NP-XXXX-XXXX: <SITE_URL>/receipt.html#NP-XXXX-XXXX` and store
  `receiptNo` in receipts.jsonl and on paid requests/registrations.
