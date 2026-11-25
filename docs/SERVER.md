# Running the agent on a server

The agent can run all day and night on a small Linux server instead of the owner's PC. It is the **same agent**
(`node src/agent.mjs watch --execute`), unchanged; systemd starts it at boot and restarts it after a crash. This page
uses a free Oracle Cloud "Always Free" VM with Ubuntu 24.04 (x86 or ARM Ampere both work), but any Ubuntu server does.

## The one rule: only one agent, ever

**Only ONE agent may ever run.** Before the server starts, the agent on the PC must be stopped **for good**. Two
agents would both see the same deposits and both try to pay them: the lock file (`agent.lock`) only protects one
machine, it can't see the other one. `scripts/server/pc-export.ps1` enforces this on the PC side: it refuses while
the PC agent runs, and afterwards it leaves a lock on the PC that names another computer, so every `--execute`
command on the PC is refused from then on.

If you ever want the PC back as the agent, stop the server first (`sudo systemctl disable --now lokalpay-agent`),
copy the state files back the same way, then delete `agent.lock` on the PC.

## What runs where

| Where | What |
|---|---|
| Server `~/lokal` | the code (a git clone of this repository) and the state files: `contacts.json`, `receipts.jsonl`, `watch-state.json`, `requests.json`, `registrations-state.json`, `ntag-payments.json`, `contract-payments.json`, `refunds.json`, the outboxes, `agent.lock`, `safety-stop.json` |
| Server `~/.celo-naira-agent` (mode 700) | `agent.json` (the key) and `status-secret`, both mode 600; optionally `env` (alert settings) |
| Server systemd | the `lokalpay-agent` service: `ExecStart=/usr/bin/node src/agent.mjs watch --execute`, logs in the journal |
| Vercel | the site and the status server (`/api/status`), unchanged. The pay pages now say when the agent is offline |
| GitHub Actions | the watchdog, unchanged: a Telegram alert when no heartbeat came for 10 minutes |
| The PC | nothing any more. Its agent is sealed by `pc-export.ps1` |

## Moving from the PC to the server, step by step

1. **Create the VM** (Oracle Cloud: Compute, Instances, Create; image Ubuntu 24.04; shape VM.Standard.A1.Flex or
   VM.Standard.E2.1.Micro; add your SSH public key). It needs no open ports besides SSH: the agent only makes outgoing
   connections. Note its public IP.
2. **On the server**, get the code and the packages (this stops at step 3 because the key isn't there yet; that's
   expected):

   ```bash
   sudo apt-get update && sudo apt-get install -y git
   git clone https://github.com/deeeko/lokal ~/lokal
   bash ~/lokal/scripts/server/setup.sh
   ```

3. **On the PC**, stop the agent (Ctrl+C in its window; close any shortcut or task that starts it), then, in the
   folder it runs from:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\server\pc-export.ps1 -Server ubuntu@YOUR.SERVER.IP -SshKey C:\path\to\oracle.key
   ```

   It writes `server-migration-manifest.txt` (a SHA-256 of each state file), seals the PC, and prints three commands
   (one `ssh`, two `scp`). Run them. They copy:

   - into `~/.celo-naira-agent/` on the server: **`agent.json`** and **`status-secret`** (from
     `%USERPROFILE%\.celo-naira-agent\`). Never paste their contents anywhere, never open them in an editor with an
     AI assistant;
   - into `~/lokal/` on the server: **`contacts.json`**, **`receipts.jsonl`**, **`watch-state.json`**, and each of
     **`requests.json`**, **`registrations-state.json`**, **`ntag-payments.json`**, **`contract-payments.json`**,
     **`refunds.json`**, **`status-outbox.jsonl`**, **`status-outbox.sent.json`**, **`alerts-outbox.jsonl`**,
     **`alerts-outbox.sent.json`** that exists on the PC, plus **`server-migration-manifest.txt`**.

   Never copy `agent.lock`, `safety-stop.json`, `node_modules`, `.env` or `.vercel`.

4. **On the server**, run setup again, this time starting the service:

   ```bash
   bash ~/lokal/scripts/server/setup.sh --start
   ```

   It checks every copied file against the PC's manifest and stops if one is missing or different.

**A fresh start is NOT allowed when records exist on the PC.** The state files are how the agent pays each deposit
exactly once: a deposit is recorded before it is paid, and `watch-state.json` says how far the chain was read.
Without them the agent would read old blocks again and could pay the same deposit twice. `setup.sh` refuses to install
the service without the PC's files. `--fresh-start` exists only for an agent that has never run anywhere.

### What setup.sh does

Run as the normal `ubuntu` user (it uses `sudo` itself). It is safe to run again at any time.

1. Installs git and Node.js 22 LTS (NodeSource), if missing.
2. Clones or updates `~/lokal` (fast-forward only) and runs `npm ci --ignore-scripts`.
3. Creates `~/.celo-naira-agent` with mode 700; checks `agent.json` and `status-secret` are there, belong to you and
   have mode 600 (it tightens a looser mode). If one is missing it stops with the copy command and installs nothing.
   It only checks that they exist; it never prints or reads them.
4. Checks the state files: on the first run against `server-migration-manifest.txt` (same SHA-256 as on the PC, and no
   record file on the server that the PC didn't have); after that, that they are all still there. Sets them to mode 600.
5. Runs `node src/agent.mjs doctor` and stops on any FAIL.
6. Installs `/etc/systemd/system/lokalpay-agent.service` and enables it (it starts at every boot). With `--start` it
   also starts it now.

## Everyday commands

| What | Command |
|---|---|
| Is it running? Last 50 log lines and the doctor | `bash ~/lokal/scripts/server/status.sh` |
| Follow the log live | `journalctl -u lokalpay-agent -f` |
| Log since yesterday | `journalctl -u lokalpay-agent --since yesterday` |
| Stop (clean: a payout in flight finishes first) | `sudo systemctl stop lokalpay-agent` |
| Start | `sudo systemctl start lokalpay-agent` |
| Restart | `sudo systemctl restart lokalpay-agent` |
| Update to the latest code | `bash ~/lokal/scripts/server/update.sh` |
| After a safety stop, once the cause is fixed | `bash ~/lokal/scripts/server/resume.sh` |
| Turn it off for good (also at boot) | `sudo systemctl disable --now lokalpay-agent` |

`update.sh` pulls (fast-forward only, it refuses when tracked files were changed by hand), runs `npm ci`, refreshes
the service file when it changed, and restarts the agent. It doesn't restart while a safety stop is on record.

Other agent commands (`refunds`, `retry`, `refund`, `status-sync`, `doctor`) run from `~/lokal` as usual. A command
with `--execute` needs the lock, so stop the service first (`sudo systemctl stop lokalpay-agent`), run it, then start
the service again.

**Alerts (optional).** Put `ALERT_TELEGRAM_TOKEN=...` and `ALERT_TELEGRAM_CHAT_ID=...` (and/or `ALERT_WEBHOOK_URL=...`),
one per line, in `~/.celo-naira-agent/env`, mode 600, then restart. Test with
`set -a; . ~/.celo-naira-agent/env; set +a; node src/agent.mjs alert-test`. The same file can hold other settings,
for example `CELO_RPC_URL`.

## When the agent stops, and when it starts again by itself

| What happened | Exit | What systemd does |
|---|---|---|
| A network problem (Forno, Blockscout, Textile, the status server) | none | nothing: autopilot keeps running and retries with backoff, nothing is skipped |
| A crash (an unexpected error) | 1 | restarts it after 30 s |
| Killed (out of memory, `kill -9`) | signal | restarts it after 30 s |
| **A safety stop** (it stopped on purpose) | **3** | **never restarts it**, not even after a reboot |
| You stopped it (`systemctl stop`) | 0 | leaves it stopped |
| More than 5 starts within 10 minutes | | gives up and leaves it stopped |

**A safety stop** is any stop autopilot makes on purpose because something needs a human: "Swap succeeded but no
USDT was received", a payout that failed, a record that couldn't be saved after a payout, the daily cap reached, a
missing attribution tag, a pre-flight check that failed. Autopilot then:

1. prints what happened in full, then one line `AUTOPILOT STOPPED: ... Fix the cause (details above), then run: ...`;
2. sends the urgent "Autopilot stopped" alert (when alerts are set up);
3. prints `SAFETY STOP (exit code 3): autopilot stopped on purpose and must not be restarted automatically.`;
4. writes `~/lokal/safety-stop.json` (`{ at, host, pid, reason }`) and exits with code **3**.

The service has `RestartPreventExitStatus=3`, so systemd does not restart it. And because `safety-stop.json` stays,
the start check refuses every later start too, including after a reboot. To resume: read the log
(`status.sh` shows the record too), fix the cause (for a failed payout, the `retry` or `refund` command autopilot
printed; stop nothing else), then run `resume.sh`: it shows the record, asks you to type `yes`, removes it and starts
the service.

The GitHub watchdog alerts you when no heartbeat arrived for 10 minutes, whatever the reason.

### The start check and stale locks

Before every start, systemd runs `scripts/server/prestart.mjs` (`ExecStartPre`). It never reads the key. In order:

1. `safety-stop.json` exists: **refuse** (exit 3). Nothing starts until `resume.sh`.
2. No `agent.lock`: **start**.
3. The lock names another computer, or can't be read: **refuse**. Check by hand.
4. The lock names this server and was written before the last boot: the machine restarted, so its process is
   certainly gone: **clear it and start**.
5. The lock's process is still running: **refuse** (another agent or `--execute` command runs here).
6. The lock's process is gone (a crash): **clear it and start**.

Clearing a stale lock here is safe because exactly-once does not depend on the lock: every deposit is recorded in the
state files before it is paid, and a payout that failed is marked failed and never retried by itself. The lock only
keeps two live processes apart, and in cases 4 and 6 none is alive. This is the same thing `--clear-stale-lock` does,
limited to the cases where no human check is needed. A refusal also counts towards the start limit, so nothing loops.

On the server, `systemctl stop` sends SIGTERM, which autopilot treats exactly like Ctrl+C: it finishes the current
step, saves, releases the lock and exits 0. It gets 120 seconds before systemd forces it.

## The pay pages say when the agent is offline

The tag pay page, the pot spray page and the payment-link page read `GET /api/status?agent=1` (the last heartbeat)
when they open. If the last heartbeat is older than 15 minutes, a small line appears above the Pay button: "The agent
is offline right now (last seen N min ago). Your payment is safe and will be paid when it's back, or it can be
refunded." While the agent is online, nothing is shown. It only warns, it never blocks paying, and when the status
can't be read it shows nothing (no false alarms).
