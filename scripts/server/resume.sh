#!/usr/bin/env bash
# After a SAFETY STOP: once you have read what stopped autopilot (bash ~/lokal/scripts/server/status.sh) and fixed the
# cause (for a failed payout: the retry or refund command autopilot printed), this clears the record and starts the
# service again.   bash ~/lokal/scripts/server/resume.sh
set -euo pipefail
. "$HOME/lokal/scripts/server/lib.sh"
cd "$APP_DIR"

if [ -e safety-stop.json ]; then
  echo "The recorded safety stop:"
  cat safety-stop.json
  printf 'Have you fixed the cause, and is no other agent running anywhere (not on the PC)? Type yes to resume: '
  read -r answer
  [ "$answer" = "yes" ] || { echo "Nothing changed."; exit 1; }
  rm -f safety-stop.json
  echo "Cleared safety-stop.json."
else
  echo "No safety stop on record."
fi
sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
sudo systemctl start "$SERVICE"
sleep 3
systemctl --no-pager --lines=15 status "$SERVICE" || true
