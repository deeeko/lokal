#!/usr/bin/env bash
# Sets up the LokalPay agent as a systemd service on an Ubuntu 24.04 server (Oracle Cloud Always Free, x86 or ARM).
# Run it as the normal login user (ubuntu), NOT as root; it uses sudo where it must. Safe to run again at any time.
#
#   bash ~/lokal/scripts/server/setup.sh            check everything, install + enable the service (does not start it)
#   bash ~/lokal/scripts/server/setup.sh --start    same, then start it (only once the PC agent is stopped for good)
#   bash ~/lokal/scripts/server/setup.sh --fresh-start
#                                                   ONLY for an agent that has never run anywhere (no records exist)
#
# What it does: installs Node.js 22 LTS (NodeSource) and git; clones or updates the repository into ~/lokal and runs
# npm ci --ignore-scripts; makes ~/.celo-naira-agent (mode 700); checks agent.json and status-secret are there (mode
# 600); checks the state files copied from the PC against the PC's manifest (scripts/server/pc-export.ps1); runs
# node src/agent.mjs doctor; installs and enables the lokalpay-agent service. docs/SERVER.md explains each step.
# It never prints, copies or reads the contents of the key or the status secret.
set -euo pipefail

START=0
FRESH=0
for a in "$@"; do
  case "$a" in
    --start) START=1 ;;
    --fresh-start) FRESH=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -ne 0 ] || { echo "Run this as the normal user (ubuntu), not as root or with sudo." >&2; exit 1; }
command -v sudo >/dev/null || { echo "sudo is needed." >&2; exit 1; }

REPO_URL=https://github.com/deeeko/lokal
APP_DIR="$HOME/lokal"

echo "== 1. Packages: git and Node.js 22 LTS"
if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq git curl ca-certificates
fi
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" != "22" ]; then
  tmp=$(mktemp)
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$tmp"
  sudo -E bash "$tmp"
  rm -f "$tmp"
  sudo apt-get install -y -qq nodejs
fi
[ "$(node_major)" = "22" ] || { echo "Node.js 22 did not install (found $(node -v 2>/dev/null || echo none))." >&2; exit 1; }
[ -x /usr/bin/node ] || { echo "The service runs /usr/bin/node, which is missing (node is at $(command -v node))." >&2; exit 1; }
echo "  OK    node $(node -v), $(git --version)"

echo "== 2. The code in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
    echo "  WARN  $APP_DIR has local changes to tracked files; not updating it (git -C $APP_DIR status)"
  else
    git -C "$APP_DIR" pull --ff-only -q
  fi
else
  git clone -q "$REPO_URL" "$APP_DIR"
fi
# shellcheck source=lib.sh
. "$APP_DIR/scripts/server/lib.sh"
(cd "$APP_DIR" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)
ok "$(git -C "$APP_DIR" log -1 --format='%h %s')"

echo "== 3. Secrets in $SECRET_DIR (never printed)"
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"
ok "$SECRET_DIR exists, mode 700"
missing=""
for f in agent.json status-secret; do
  if check_private_file "$SECRET_DIR/$f"; then ok "$f is there, mode 600"; else missing="$missing $f"; fi
done
if [ -n "$missing" ]; then
  die "missing in $SECRET_DIR:$missing
Copy them from the PC (PowerShell on the PC, see docs/SERVER.md), then run this script again:
  scp \$env:USERPROFILE\\.celo-naira-agent\\agent.json \$env:USERPROFILE\\.celo-naira-agent\\status-secret ubuntu@SERVER:.celo-naira-agent/
Never paste their contents anywhere. The service was NOT installed."
fi
if [ -f "$SECRET_DIR/env" ]; then check_private_file "$SECRET_DIR/env"; ok "env (alert settings) is there, mode 600"; fi

echo "== 4. State files in $APP_DIR (exactly-once depends on them)"
cd "$APP_DIR"
ALL_STATE="$REQUIRED_STATE $RECORD_STATE $QUEUE_STATE"
for f in $ALL_STATE; do if [ -f "$f" ]; then chmod 600 "$f"; fi; done
if [ -e agent.lock ]; then warn "agent.lock is here; the service's prestart step decides whether it is stale (docs/SERVER.md)"; fi
if [ -e safety-stop.json ]; then warn "safety-stop.json is here: autopilot will not start until you run scripts/server/resume.sh"; fi
if [ -f "$MIGRATED_MARK" ]; then
  # Already taken over from the PC: since then the agent changes these files, so only their presence is checked.
  for f in $(awk '{print $2}' "$MIGRATED_MARK" | sed 's/^\*//'); do
    [ -f "$f" ] || die "$f was copied from the PC but is gone now. Restore it before the agent runs again (never start fresh)."
  done
  ok "the state files taken over from the PC earlier (listed in $MIGRATED_MARK) are all present"
elif [ -f "$MANIFEST_NAME" ]; then
  MAN=$(mktemp)
  tr -d '\r' <"$MANIFEST_NAME" >"$MAN" # the PC writes LF; this only guards against a converted copy
  names=$(awk '{print $2}' "$MAN" | sed 's/^\*//')
  echo "$names" | grep -qx contacts.json || die "$MANIFEST_NAME does not list contacts.json. Run scripts/server/pc-export.ps1 on the PC again."
  for f in $names; do
    case " $ALL_STATE " in *" $f "*) ;; *) die "$MANIFEST_NAME lists an unexpected file: $f" ;; esac
  done
  for f in $ALL_STATE; do
    if [ -f "$f" ] && ! echo "$names" | grep -qx "$f"; then
      die "$f is on the server but was not on the PC. Remove it (it is not the PC's record), then run this again."
    fi
  done
  if ! sha256sum --check --strict --quiet "$MAN"; then
    die "the files above are missing or differ from the PC. Copy them again from the PC (the PC agent must stay stopped), then run this again."
  fi
  for f in $names; do ok "$f matches the PC"; done
  MIGRATE_NOW=1
elif [ "$FRESH" = 1 ]; then
  [ -f contacts.json ] || die "contacts.json is missing (copy contacts.example.json to contacts.json and fill it in)."
  warn "--fresh-start: no records from a PC. This is ONLY allowed for an agent that has never run anywhere."
  MIGRATE_NOW=1
else
  die "no state files from the PC. A fresh start is NOT allowed when records exist on the PC: without them the agent
could pay the same deposit twice. On the PC: stop the agent, run scripts/server/pc-export.ps1, and copy what it lists
into $APP_DIR (that is: $REQUIRED_STATE, and each of
$RECORD_STATE
$QUEUE_STATE
that exists on the PC, plus $MANIFEST_NAME). Then run this again.
The service was NOT installed."
fi

echo "== 5. Doctor (reads public data and the state files; never the key)"
if node src/agent.mjs doctor; then ok "doctor: no FAIL"; else die "doctor found a FAIL (above). Fix it, then run this again. The service was NOT installed."; fi
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo no)" != "yes" ]; then
  warn "the clock is not NTP-synchronized yet; signed status reports need the right time (timedatectl status)"
fi

if [ "${MIGRATE_NOW:-0}" = 1 ]; then
  if [ -n "${MAN:-}" ]; then cp "$MAN" "$MIGRATED_MARK"; rm -f "$MAN" "$MANIFEST_NAME"; else : >"$MIGRATED_MARK"; fi
  chmod 600 "$MIGRATED_MARK"
  ok "recorded the takeover in $MIGRATED_MARK"
fi

echo "== 6. The systemd service $SERVICE"
install_unit
sudo systemctl enable -q "$SERVICE"
ok "enabled (starts at boot)"
if [ "$START" = 1 ]; then
  sudo systemctl start "$SERVICE"
  sleep 3
  systemctl --no-pager --lines=0 status "$SERVICE" || true
  ok "started. Logs: journalctl -u $SERVICE -f"
else
  say "  Not started. Once the PC agent is stopped for good, start it with:"
  say "    sudo systemctl start $SERVICE      (logs: journalctl -u $SERVICE -f)"
fi
say ""
say "ONLY ONE AGENT MAY EVER RUN. Do not start the agent on the PC again (docs/SERVER.md)."
