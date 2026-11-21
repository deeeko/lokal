# Command lines: `lokal` and the agent

Two command lines. **`lokal`** pays a tag from your own wallet in a terminal. **The agent CLI** (`src/agent.mjs`) is
the operator's: quotes, payouts, autopilot, refunds. Running the agent day to day is in [OPERATOR.md](OPERATOR.md).

## The `lokal` command line (PowerShell)

`src/ntag.mjs` (the `lokal` command; `ntag`, its name before the rename, runs the same thing) lets anyone pay a Lokal
tag from **their own wallet** in a terminal. It never touches the agent's key and
refuses to use it.

### Install the lokal command (Windows)

The quickest way, for anyone: open PowerShell (no admin needed) and paste

```powershell
irm https://lokalpay.vercel.app/install.ps1 | iex
```

Requirement: **Node.js 20 or newer**. If it is missing or too old, the installer says how to get it
(`winget install OpenJS.NodeJS.LTS` or https://nodejs.org) and stops; it never installs system software itself.
You can read [`site/install.ps1`](../site/install.ps1) (served as plain text at the URL above) before running it. It:

1. checks for Node.js 20+ and npm;
2. downloads the code as a zip from GitHub (`codeload.github.com/deeeko/lokal/zip/<ref>`, `main`
   unless `$env:NTAG_REF` names a branch, tag or commit), over TLS 1.2 in Windows PowerShell 5.1 too;
3. runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` in a staging folder and checks that `lokal help` runs;
4. swaps it into `%LOCALAPPDATA%\lokal\app` with a rename (a failed update keeps the previous install);
5. writes `%LOCALAPPDATA%\lokal\bin\lokal.cmd`, plus `ntag.cmd` (the command's old name, so `ntag` keeps working),
   and adds that folder to your **user** PATH (and to the current window). `$env:NTAG_NO_PATH = "1"` skips the PATH
   change and prints the folder to add instead;
6. cleans up an install from before the rename to Lokal: deletes `%LOCALAPPDATA%\naira-payout\app` and `bin` and takes
   the old bin folder out of your user PATH, so the old `ntag` can never shadow the new one.

Then: `lokal wallet new`, send USD₮ and a little CELO (for fees) to the address `lokal wallet` shows, `lokal whois ada`,
`lokal send ada 10`. `ntag` still works as another name for the same command. Written for both Windows PowerShell 5.1
(built into Windows) and PowerShell 7.

- **Update:** run the same line again.
- **Uninstall:** `$env:NTAG_UNINSTALL = "1"; irm https://lokalpay.vercel.app/install.ps1 | iex` removes the app
  and bin folders and the PATH entry. By hand: delete both folders and remove the bin folder from your user PATH.
- **Your wallet is separate:** `%USERPROFILE%\.lokal\wallet.json` (or `NTAG_WALLET_FILE`). The installer never
  creates, reads, moves or deletes it, so updates and uninstalls keep it. Back it up, for example
  `Copy-Item $HOME\.lokal\wallet.json D:\backup\`, and remember the send password.
- **Wallets made before the rename** stay at `%USERPROFILE%\.naira-payout\wallet.json`. When that file exists and the
  new one doesn't, `lokal` keeps using it where it is and says so once; nothing is moved for you.

**Setup** (from a checkout of this repo, any OS)

```powershell
cd lokal
npm install
npm link                          # optional: makes "lokal" (and "ntag") a command; otherwise use "node src/ntag.mjs" or "npm run lokal --"

lokal wallet new                  # creates a wallet, encrypted with a send password you choose (min 8 characters, typed twice)
lokal wallet import               # or use a key you already have (typed at a hidden prompt, or NTAG_PRIVATE_KEY)
lokal wallet                      # address, CELO / USD₮ / cNGN balances and your Lokal tag
```

The wallet file (default `%USERPROFILE%\.lokal\wallet.json`, or the older `.naira-payout\wallet.json` if only that exists; override with `NTAG_WALLET_FILE`) holds the key
encrypted with **scrypt (N = 131072) and AES-256-GCM**; on Windows its permissions are limited to your user. `lokal`
never shows or exports the key and never overwrites an existing wallet. There is no recovery: back up the file and
remember the password; if you forget it, re-import your own key backup with a new password.

**Pay someone**

`send` pays in the tag owner's preferred currency, or naira if they have none. Choose another with `--to`
(`lokal send ada 10 --to rupiah`; names, codes and ISO codes all work), or dollars with `--dollars`.

In PowerShell, `@` at the start of an argument is special. Leave it out (`ada`) or quote it (`'@ada'`).

```powershell
lokal whois ada                   # who owns @ada, and how much more they can receive today
lokal send ada 10                 # you send $10 USD₮, @ada gets naira
lokal send ada 14000 --dollars    # you send ₦14,000 cNGN, @ada gets dollars (USD₮)
lokal send ada 10 --wait          # after sending, wait for the agent's payout and print the receipt number
lokal send ada 5.50 --dry-run     # show the exact transaction (to / data / value), send nothing
lokal status 0x<txhash>           # is that payment confirmed and paid out?

npm run lokal -- send ada 10 --wait              # the same without npm link
node src/ntag.mjs send '@ada' 5.50 --dry-run
```

What `send` does, in order: checks the tag and re-reads its claim onchain; refuses your own tag; checks your token
balance and CELO for gas; checks the owner's remaining $25-per-day allowance and refuses a payment the agent would not
pay automatically; prints a summary with the estimate and today's limits; asks you to **type the tag** to confirm
(`--yes` skips this for scripts); asks for the **send password**; re-checks the owner right before signing; sends and
waits for confirmation.

Amounts: USD₮ $1.00 to $25.00; cNGN worth at least $1 and up to about $24 in naira (3% under the agent's $25 limit, so
a price move cannot push it over). At most 2 decimals; `$10.29`, `₦14,000` are accepted.

**Your own tag**

```powershell
lokal claim ada --name "Ada Obi"  # claim @ada for your wallet (public and permanent)
lokal release                     # give up your tag (locked for you for 30 days)
lokal wallet password             # change the send password (old one, then the new one twice)
```

**Send password and lockout**: `send`, `claim` and `release` ask for the password after you confirm, before anything is
signed. 3 tries per command; **5 wrong passwords in 10 minutes lock the wallet for 5 minutes**. For scripts,
`NTAG_PASSWORD` (and `NTAG_OLD_PASSWORD` for `wallet password`) answer the prompts; that is less safe, because other
programs can read environment variables.

| Option | Meaning |
|---|---|
| `--dollars` | pay in cNGN so the owner gets dollars (default `--naira`: pay USD₮, owner gets naira) |
| `--yes`, `-y` | skip typing the tag to confirm |
| `--wait` | wait for the agent's payout (up to 30 minutes, `NTAG_WAIT_MINUTES`) and print the receipt number |
| `--dry-run` | show the exact transaction and send nothing (works without a wallet) |
| `--name "..."` | display name for `claim` (1–40 characters) |

Settings: `NTAG_WALLET_FILE`, `CELO_RPC_URL` (default Forno), `NTAG_PASSWORD`, `NTAG_OLD_PASSWORD`, `NTAG_PRIVATE_KEY`
(for `wallet import`), `NTAG_WAIT_MINUTES`, `NO_COLOR`.

## Pay from CELO (operator)

Textile has no CELO → cNGN pair, so `celo-cngn` is **two swaps and two Textile fees**: CELO → USD₮, then exactly the
USD₮ that arrived → cNGN, then the cNGN received is paid out (`src/celo.mjs`). Each swap must clear Textile's minimum of
about $1, so the first swap must preview at least **1.05 USD₮** (about 20 CELO at today's rate). The agent always keeps
**2 CELO** (`MIN_CELO_RESERVE`) plus a **0.1 CELO** gas margin after selling, because CELO also pays its network fees.
It is for direct operator payouts only: payment links, "Get paid" and autopilot refuse it. If the second swap or the
payout fails after the first swap went through, the agent stops and prints where the money is (for example
"1.091835 USDT is in the agent wallet") and the exact command that finishes the job.

```powershell
node src/agent.mjs quote --corridor celo-cngn --amount 20
node src/agent.mjs pay --to ada --amount 20 --corridor celo-cngn            # dry run
node src/agent.mjs pay --to ada --amount 20 --corridor celo-cngn --execute  # real, asks you to type yes
```

## Run it yourself

Needs Node.js 20 or newer (CI and the deploy use Node 22).

```powershell
git clone https://github.com/deeeko/lokal.git
cd lokal
npm install
npm test
node scripts/serve.mjs            # preview the site at http://localhost:4173
```

### The agent CLI

```powershell
node src/agent.mjs keygen                      # creates the agent wallet (key is never printed)
node src/agent.mjs status                      # balances, tag, caps, USD paid in the last 24 h, open requests
node src/agent.mjs quote --amount 10           # free live price, no wallet needed
node src/agent.mjs quote --corridor cngn-usdt --amount 14400
node src/agent.mjs quote --corridor celo-cngn --amount 20

node src/agent.mjs pay --to ada --amount 10              # DRY RUN
node src/agent.mjs pay --to ada --amount 10 --execute    # real, asks you to type yes
node src/agent.mjs ask "send $10 to ada"                  # DRY RUN, plain language (usdt-cngn)

node src/agent.mjs request --to ada --amount 5           # payment link with a unique amount
node src/agent.mjs requests                              # open | received | paid | expired
node src/agent.mjs registrations                         # Get paid: active | in-use | expired | invalid | received | paid

node src/agent.mjs watch                                 # autopilot DRY RUN
node src/agent.mjs watch --execute                       # autopilot: pays matched deposits
node src/agent.mjs retry --request r_ab12cd34            # DRY RUN of a failed payout (add --execute)
node src/agent.mjs retry --registration 0x<hash>
node src/agent.mjs retry --ntag 0x<tx>:<logIndex>

node src/agent.mjs ntag ada                              # owner, name, since, claim tx, status (free | taken | locked | ...)
node src/agent.mjs ntags                                 # every tag held right now
node src/agent.mjs pay '@ada' 10                         # DRY RUN: operator payout to a tag owner (add --execute)
node src/agent.mjs pay --ntag ada --amount 10            # the same, PowerShell-friendly
node src/agent.mjs ntag-data '@ada' 10 --token usdt      # the to/data to pay a tag from your own wallet; uses no key

node src/agent.mjs refunds                               # refundable deposits and every refund: key, payer, token, amount, reason, age, status
node src/agent.mjs refund --deposit 0x<tx>:<logIndex>    # DRY RUN with a gas estimate; --execute sends it back (asks for yes)
node src/agent.mjs refund --deposit 0x<tx>:<logIndex> --retry --execute   # after a failed refund: searches the chain first
node src/agent.mjs watch --execute --auto-refund         # autopilot that also refunds refused tag and Get paid deposits

node src/agent.mjs doctor                                # PASS / WARN / FAIL for the whole setup (never reads the key)
node src/agent.mjs alert-test                            # sends a test alert to Telegram and/or ALERT_WEBHOOK_URL
node src/agent.mjs watch --execute --clear-stale-lock    # after a crash left agent.lock behind (check first)

node src/agent.mjs register --execute                    # ERC-8004 identity on Celo mainnet
node src/agent.mjs verify 0x<txhash>                     # shows a transaction's attribution tag
```

`npm start`, `npm run quote`, `npm run requests`, `npm run watch` and `npm run lokal` (or `npm run ntag`) are shortcuts.

| Command | Flags |
|---|---|
| `keygen` | none |
| `status` | none (needs the key file) |
| `quote` | `--amount N` (default 10 USD₮, ₦14,400 or 20 CELO), `--corridor ID` |
| `pay` | `--to NAME --amount N`, `--corridor ID` (incl. `celo-cngn`), `--execute`, `--yes`; or `@tag N` / `--ntag TAG --amount N` (not `celo-cngn`) |
| `ask "TEXT"` | `--execute`, `--yes` (always `usdt-cngn`) |
| `request` | `--to NAME --amount N`, `--corridor ID`, `--note TEXT` (≤ 80 chars), `--hours H` (default 48, at most 168) |
| `requests`, `registrations`, `ntags` | none |
| `ntag <@tag or address>` | none |
| `ntag-data @tag N` | `--token usdt` (default) or `cngn` |
| `watch` | `--execute`, `--interval SECONDS` (default 15, minimum 5), `--auto-refund` (with `--execute`), `--clear-stale-lock` |
| `retry` | `--request ID`, `--registration HASH` or `--ntag TX:LOGINDEX`; `--force-refused` (Lokal tag only; refused when the deposit has a refund record), `--execute`, `--yes`, `--clear-stale-lock` |
| `refunds` | none |
| `refund` | `--deposit TX:LOGINDEX`, `--execute`, `--yes`, `--retry` (after a failed or stuck refund), `--clear-stale-lock` |
| `alert-test`, `doctor` | none |
| `register` | `--repo URL`, `--execute` (needs the key file) |
| `verify <hash>` | none (needs the key file) |

Every command with `--execute` (`watch`, `pay`, `ask`, `retry`, `register`, `refund`) takes `agent.lock` first and is
refused while another one holds it; add `--clear-stale-lock` only after checking that no agent is running.

`ID` is `usdt-cngn` (default) or `cngn-usdt`; `pay` and `quote` also take `celo-cngn`. `NAME` must be in `contacts.json`
(case-insensitive): copy `contacts.example.json` to `contacts.json` and add recipients, plus any `own_wallets` the agent
must never pay. Autopilot needs a computer that keeps `watch --execute` running with the key file; it pays only while
running.

### Environment variables

All optional (see `.env.example`).

| Variable | Default | Controls |
|---|---|---|
| `MAX_USD` | `25` | Largest single payout, in USD |
| `MAX_WALLET_DAILY_USD` | `25` | Most USD paid to any one wallet in a rolling 24 h (Get paid and Lokal tag payouts) |
| `MAX_DAILY_USD` | `100` | Most USD paid out in any rolling 24 h |
| `MAX_SLIPPAGE_BPS` | `300` | Allowed gap between preview and firm quote (300 = 3%), per swap |
| `MIN_CELO_RESERVE` | `2` | CELO the agent must still hold after a `celo-cngn` payout |
| `CELO_GAS_MARGIN` | `0.1` | CELO set aside for the gas of a `celo-cngn` payout (up to 7 transactions) |
| `ATTRIBUTION_CODE` | `celo_7360953d1b53` | Tag on every transaction (1–32 chars of a–z, 0–9, _) |
| `AGENT_ADDRESS` | `0x8a695cf54CB44753c8b784EB36d266f748617a1e` | Agent address when there is no key file (`request`, dry-run `watch`) |
| `SITE_URL` | `https://lokalpay.vercel.app` | Site used in payment and receipt links |
| `CELO_AGENT_KEY_FILE` | `~/.celo-naira-agent/agent.json` | Agent private key, outside the repo |
| `CONTACTS_FILE` | `contacts.json` | Allow-list and `own_wallets` |
| `RECEIPTS_FILE` | `receipts.jsonl` | Executed payouts and refused or unmatched deposits; the daily caps are counted from it |
| `REQUESTS_FILE` | `requests.json` | Operator payment requests |
| `WATCH_STATE_FILE` | `watch-state.json` | Autopilot block cursor (written only with `--execute`) |
| `REGISTRATIONS_STATE_FILE` | `registrations-state.json` | "Get paid" deposits and payouts |
| `NTAG_PAYMENTS_FILE` | `ntag-payments.json` | Lokal tag deposits seen by autopilot, keyed by `tx:logIndex` |
| `BLOCKSCOUT_API` | `https://celo.blockscout.com/api/v2` | Where registrations and tag claims are discovered |
| `CELO_RPC_URL` | Forno | RPC for `watch`, the agent's read commands and the `lokal` CLI |
| `TEXTILE_API` | `https://api.textilecredit.com/v2` | Textile FX RFQ endpoint |
| `NTAG_WALLET_FILE` | `~/.lokal/wallet.json` (or `~/.naira-payout/wallet.json` if only that exists) | `lokal` CLI wallet (encrypted) |
| `NTAG_PASSWORD`, `NTAG_OLD_PASSWORD` | not set | Answer the `lokal` password prompts in scripts (less safe) |
| `NTAG_PRIVATE_KEY` | not set | Key for `lokal wallet import` instead of the hidden prompt |
| `NTAG_WAIT_MINUTES` | `30` | How long `lokal send --wait` waits for the payout |
| `NP_STATUS_SECRET` | not set | Shared secret that signs status reports (or the file `status-secret` next to the agent key) |
| `STATUS_URL` | `<SITE_URL>/api/status` | Where autopilot reports payout status |
| `STATUS_OUTBOX_FILE` | `status-outbox.jsonl` | Queue of reports waiting to be sent |
| `REFUNDS_FILE` | `refunds.json` | Refunds, keyed by `tx:logIndex` (`sending`, `refunded`, `failed`, `too_small_to_refund`) |
| `MAX_DAILY_REFUND_USD` | `100` | Most USD refunded in any rolling 24 h (refunds never count towards the payout caps) |
| `MIN_REFUND_USD` | `1` | Deposits worth less are recorded as `too_small_to_refund` and left alone |
| `AGENT_LOCK_FILE` | `agent.lock` (next to `watch-state.json`) | One agent at a time |
| `LOW_CELO_WARN` | `3` | Autopilot warns (and alerts) when the agent holds less CELO |
| `ALERT_TELEGRAM_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | not set | Telegram alerts (a bot token is a secret: never commit it) |
| `ALERT_WEBHOOK_URL` | not set | Webhook alerts: an https URL that takes a JSON POST `{ text, content, level, kind, at }` |
| `ALERT_MUTE` | not set | Info alerts to mute: `payout_paid`, `deposit_refused` (comma-separated) |
| `ALERTS_OUTBOX_FILE` | `alerts-outbox.jsonl` | Alerts waiting to be sent |

State files (`contacts.json`, `receipts.jsonl`, `requests.json`, `watch-state.json`, `registrations-state.json`,
`ntag-payments.json`, `refunds.json`, `status-outbox.jsonl`, `alerts-outbox.jsonl`, `agent.lock`), `.env*` and key files are git-ignored. Textile quotes need no API key; a signed proof of wallet
control (no funds moved) is sent only if Textile asks for it.
