#!/usr/bin/env bash
# The agent's state on the server: the service, the last 50 journal lines, a recorded safety stop, and the doctor.
# Read-only; never prints the key or the status secret.   bash ~/lokal/scripts/server/status.sh
set -uo pipefail
. "$HOME/lokal/scripts/server/lib.sh"
cd "$APP_DIR" || exit 1

echo "== systemctl status $SERVICE"
systemctl --no-pager status "$SERVICE"
echo
echo "== last 50 journal lines"
journalctl -u "$SERVICE" -n 50 --no-pager
echo
if [ -e safety-stop.json ]; then
  echo "== SAFETY STOP on record (autopilot will not start until you fix the cause and run scripts/server/resume.sh)"
  cat safety-stop.json
  echo
fi
echo "== doctor"
node src/agent.mjs doctor
