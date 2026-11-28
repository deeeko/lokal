# Operating the agent

What the operator runs and watches: the status server and heartbeat, refunds, one agent at a time, alerts and
`doctor`. The step-by-step checklist for a first real payout is [RUNBOOK.md](RUNBOOK.md); every command and
setting is in [CLI.md](CLI.md).

## Setup

1. `node src/agent.mjs keygen` creates the agent wallet; the key stays in `~/.celo-naira-agent/agent.json`, outside the
   repo, and is never printed.
2. Copy `docs/examples/contacts.example.json` to `contacts.json` for allow-listed recipients and the `own_wallets` the agent must
   never pay.
3. Optional: a status secret (`NP_STATUS_SECRET`, or the file `status-secret` next to the agent key) and alerts
   (`ALERT_TELEGRAM_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL`). Check everything with
   `node src/agent.mjs doctor`.
4. `node src/agent.mjs watch --execute` runs autopilot. It pays only while it runs, on a computer that keeps it running.

## Status server (exact payout status on the site)

Autopilot reports what it did with each deposit to the site's `/api/status`: **paid** (with its receipt number),
**refused** (with a reason code), or **received** and being paid now, plus the owner's direct payouts. The site then
shows exact facts and today's exact room under the limits, marked "Live status from the agent". Whenever the status
server is unavailable or has no record, the site estimates from the Celo chain as before, marked "Estimated from Celo".

- **Only public facts are stored:** addresses, transaction hashes, amounts, the tag and the receipt number, plus each
  deposit's status and a refusal reason code. They live in one private Vercel Blob (`status/summary.json`) for 30 days.
- **Only the agent can write.** Reports are signed with a shared secret (HMAC-SHA256 over the timestamp and the exact
  body, valid for 5 minutes, timing-safe check). The secret is set in the site's `NP_STATUS_SECRET` and on the agent's
  PC (`NP_STATUS_SECRET` or the file `status-secret` next to the agent key), never in the repo. Without it, reporting
  is simply off.
- **It can never affect a payout.** Reports are appended to `status-outbox.jsonl` and sent in the background with
  retries; a failing or slow status server never blocks, delays or changes what autopilot pays. A payout that fails is reported as "failed" and shown as "Payout delayed".
- **One read per request.** `GET /api/status?tx=…`, `?recipient=…` or `?tag=…` reads the summary once and is cached
  at the edge for 10 seconds. The site always uses the stricter of the agent's fresh totals and the chain for "room today", so a stale report can never let a payer send over a limit.
- `node src/agent.mjs status-sync` checks the setup and sends anything waiting; `--backfill` re-sends every saved
  record from the last 30 days (run it once after the first deploy).
- **Refunds are a status too.** A deposit sent back to its payer is reported as **refunded**, with its refund
  transaction (`refundTx`) and refund number (`refundNo`, `RF-XXXX-XXXX`), so the payer's status page can say
  "Refunded" with the link. "refunded" beats received, failed and refused; nothing beats "paid"; a deposit reported as
  both paid and refunded is a conflict the server logs and never merges. A deposit that matched nothing (unmatched or
  ambiguous) is reported with `kind: "deposit"`, which only ever appears with "refunded".

### Agent heartbeat: `GET /api/status?agent=1`

While `watch --execute` runs with a status secret, autopilot posts a **signed heartbeat about once a minute**
(`{ v: 1, ts, heartbeat }`, the same HMAC as reports, fire and forget: it never blocks a payout). The server checks it
strictly, refuses a replay of an older one (409), and keeps it in its own small blob (`status/agent.json`), never with
the deposit records. To save blob writes it is stored when `lowGas`, `autoRefund` or `version` changed or the stored one
is 4 minutes old, so `lastSeen` is at most about 5 minutes behind while the agent runs.

```
GET /api/status?agent=1
200 { "ok": true, "source": "agent", "agent": null }                        // no heartbeat stored yet
200 { "ok": true, "source": "agent", "agent": {
        "lastSeen": "2026-11-21T12:00:00.000Z",  // when the server last stored a heartbeat (server clock)
        "ageSec": 42,                            // seconds since lastSeen, worked out on every read
        "at": "2026-11-21T12:00:00.000Z",        // the agent's own clock when it sent it
        "cursorBlock": "41234567",               // last block autopilot fully processed (string, or null)
        "chainHead": "41234569",                 // latest Celo block it saw (string, or null)
        "lagBlocks": 2,                          // chainHead - cursorBlock (or null)
        "celoBalance": "12.5",                   // the agent's CELO for gas (string, or null if unreadable)
        "lowGas": false,                         // under LOW_CELO_WARN (default 3 CELO)
        "version": "0.1.0+c91eba0",              // package version + git commit
        "autoRefund": false } }                  // watch --auto-refund on?
503 { "ok": false, "reason": "unavailable" }     // no storage configured
```

Cached at the edge for 10 seconds like every GET. The site can show "Agent online · last seen N min ago" from `ageSec`
(the watchdog below calls the agent offline after 10 minutes). The tag pay page, the pot spray page and the
payment-link page use it: when the last heartbeat is older than 15 minutes they show "The agent is offline right now"
above the Pay button (a warning only; nothing when the status can't be read).

**Watchdog** (`.github/workflows/agent-watchdog.yml`, `scripts/agent-watchdog.mjs`): every 15 minutes GitHub Actions
reads `?agent=1` and sends a Telegram alert (repository secrets `ALERT_TELEGRAM_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`) when
the last heartbeat is more than 10 minutes old or the status server can't be read; while it stays down it re-alerts
every 60 minutes, and it sends one "back online" message when heartbeats return.

## Refunds

Money autopilot will never pay (a refused deposit, a payment to an expired or already used link, an unmatched or
ambiguous deposit) stays in the agent wallet until the operator decides. `refund` sends it back to the wallet it came
from: the `from` of the deposit's Transfer log, in the same token (USD₮, cNGN, IDRX, wARS or wCOP, in that token's own
decimals), for exactly the same amount. The agent pays the gas. Full rules: [docs/REFUNDS.md](REFUNDS.md).

```powershell
node src/agent.mjs refunds                                     # key, payer, token, amount, reason, age, status
node src/agent.mjs refund --deposit 0x<tx>:<logIndex>          # DRY RUN with a gas estimate
node src/agent.mjs refund --deposit 0x<tx>:<logIndex> --execute
```

1. **Dry run first**, with every check and a gas estimate. With `--execute`: type `yes` (or `--yes`) → take the agent
   lock → re-read the deposit over RPC (succeeded, sent to the agent, token, amount, `from`) → check it is not paid,
   refunded or in progress across `requests.json`, `registrations-state.json`, `ntag-payments.json` and `refunds.json`.
2. **Record first:** `refunds.json` gets `status: "sending"` (keyed by `<tx>:<logIndex>`) **before** the transfer.
3. **Send** with the attribution-tagged wallet client, wait for the receipt and check its Transfer log (from the agent,
   to the depositor, that token and amount), then mark it **refunded** with `refundTx` and a refund number
   `RF-XXXX-XXXX` (the first 8 hex characters of the refund tx; payout receipts keep `NP-`).
4. **Log** it to `receipts.jsonl` as `kind: "refund"` (the payout caps skip these lines) and report "refunded" to the
   status server.

| Never refunded | Why |
|---|---|
| A paid deposit, or one with a payout recorded (received, failed) | it was (or may be) paid; a failed payout is settled with `retry` |
| A transfer from one of your `own_wallets` | a top-up |
| The agent's own swap output, or a transfer from the Textile reactor or another known contract | not a payer |
| A deposit autopilot has no record of | it may still match a link; let `watch` see it first |
| Worth under `MIN_REFUND_USD` (default $1) | recorded as `too_small_to_refund` and left alone |
| Over `MAX_DAILY_REFUND_USD` (default $100) of refunds in 24 h | refunds have their own cap, apart from the payout caps |

- **A refunded deposit is never paid.** Autopilot skips any deposit with a refund record, also on a rescan, and
  `retry --force-refused` refuses one. **A paid deposit is never refunded.**
- **A failure after recording is `failed`, never retried automatically,** with an urgent alert. `--retry` first searches
  the chain for a transfer from the agent to that payer of that token and amount after the record time (and checks a
  saved refund tx); only when there is none does it send again. A crash mid-send leaves `sending`, which blocks
  everything until `--retry` (after 10 minutes) settles it the same way.
- **Auto-refund is opt-in:** `watch --execute --auto-refund` refunds refused LokalPay tag and "Get paid" deposits right
  after refusing them, at most 3 per payer per 24 hours. Unmatched and ambiguous deposits are always refunded by hand. A
  failed auto-refund is recorded and alerted and never stops autopilot.

## Operator safety: one agent at a time, alerts, doctor

**One agent at a time** (`src/lock.mjs`). `watch --execute` and every command that can move money (`pay`, `ask`,
`retry`, `register`, `refund`, each with `--execute`) first create `agent.lock` next to the watch state, with the `wx`
flag, holding `{ pid, host, startedAt, command }`. A second one is refused: "Autopilot is already running (pid N,
started T)." A lock whose process is gone (a crash) is **never removed automatically**: the command says a stale lock
was found and asks you to check, then run it again with `--clear-stale-lock`. The lock is released on normal exit,
Ctrl+C, SIGTERM and uncaught exceptions. Dry runs never take it. On a server ([SERVER.md](SERVER.md)) the service's
start check clears a stale lock by itself, but only one from the same machine whose process is gone, and never after
a safety stop (exit code 3, `safety-stop.json`).

**Alerts** (`src/alerts.mjs`, optional). Telegram (`ALERT_TELEGRAM_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`) and/or any
webhook (`ALERT_WEBHOOK_URL`, a JSON POST `{ text, content, level, kind, at }` that Slack and Discord read). Alerts wait
in `alerts-outbox.jsonl` and are sent in the background (5-second timeout, retries with backoff, dropped after 8 tries
or 24 hours), so a failing alert never stops or changes a payout. They never contain keys or secrets. Test the setup
with `node src/agent.mjs alert-test`.

| Alert | Level | When |
|---|---|---|
| Autopilot stopped | urgent | it stopped on an error; with the reason and the exact resume command |
| Payout failed | urgent | with the `retry` command for that deposit |
| Refund failed | urgent | with the `refund --retry` command |
| Daily cap reached | warning | the global `MAX_DAILY_USD` stopped autopilot |
| CELO low | warning | under `LOW_CELO_WARN` (default 3 CELO) or the hard reserve (`MIN_CELO_RESERVE`); checked at most once a minute, re-warned at most hourly, at once when it drops below the reserve |
| Status server unreachable | warning | no good answer for 10 minutes |
| Deposit refused | info | with the `refund` command (mute with `ALERT_MUTE=deposit_refused`) |
| Payout paid | info | with the receipt (mute with `ALERT_MUTE=payout_paid`) |

When autopilot stops on an error, its **last line** says what happened and how to restart, e.g.
`AUTOPILOT STOPPED: Payout to @ada failed: … Nothing more is paid until you restart it. Fix the cause (details above), then run: node src/agent.mjs watch --execute`.

**Doctor** (`node src/agent.mjs doctor`, `src/doctor.mjs`): PASS / WARN / FAIL for the lock, Forno, Blockscout's lag,
a $1 Textile preview, the agent's CELO for gas, whether a status secret is set up (never printed), whether every state
file parses, how many deposits are refundable, and every token's decimals onchain against the config. It never reads
the agent key file (it uses `AGENT_ADDRESS`).
