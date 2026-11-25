#!/usr/bin/env bash
# Updates the agent on the server: pull the latest code, install the exact dependencies, refresh the service file if it
# changed, and restart. The restart is the same clean stop as Ctrl+C: a payout in flight finishes first.
#   bash ~/lokal/scripts/server/update.sh
set -euo pipefail
. "$HOME/lokal/scripts/server/lib.sh"
cd "$APP_DIR"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "$APP_DIR has local changes to tracked files (git status). Nothing was updated."
fi
before=$(git rev-parse --short HEAD)
git pull --ff-only -q
after=$(git rev-parse --short HEAD)
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
ok "code $before -> $after"
install_unit
if [ -e safety-stop.json ]; then
  warn "a safety stop is on record: not restarting. Fix the cause, then run scripts/server/resume.sh"
  exit 0
fi
if systemctl is-active --quiet "$SERVICE"; then
  sudo systemctl restart "$SERVICE"
  ok "restarted $SERVICE"
else
  say "  $SERVICE is not running; start it with: sudo systemctl start $SERVICE"
fi
