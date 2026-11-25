# Shared by the scripts in scripts/server/ (sourced, not run). docs/SERVER.md explains the whole setup.
# Nothing here ever prints the agent key or the status secret: they are only tested for existence and permissions.

SERVICE=lokalpay-agent
UNIT_SRC_NAME=lokalpay-agent.service
UNIT_DST=/etc/systemd/system/$SERVICE.service
REPO_URL=https://github.com/deeeko/lokal
APP_DIR="$HOME/lokal"
SECRET_DIR="$HOME/.celo-naira-agent"
MIGRATED_MARK="$SECRET_DIR/migrated-from-pc.txt"
MANIFEST_NAME=server-migration-manifest.txt

# Every file the agent keeps in ~/lokal (src/config.mjs). REQUIRED_STATE must exist on a server that takes over from
# the PC; RECORD_STATE and QUEUE_STATE are copied whenever they exist on the PC (pc-export.ps1 lists them).
REQUIRED_STATE="contacts.json receipts.jsonl watch-state.json"
RECORD_STATE="requests.json registrations-state.json ntag-payments.json contract-payments.json refunds.json"
QUEUE_STATE="status-outbox.jsonl status-outbox.sent.json alerts-outbox.jsonl alerts-outbox.sent.json"

say() { printf '%s\n' "$*"; }
ok() { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# The unit file with this machine's user, group and home in place of ubuntu / /home/ubuntu.
render_unit() {
  sed -e "s#/home/ubuntu#$HOME#g" -e "s#^User=ubuntu\$#User=$(id -un)#" -e "s#^Group=ubuntu\$#Group=$(id -gn)#" \
    "$APP_DIR/scripts/server/$UNIT_SRC_NAME"
}

# Installs (or refreshes) the unit when it changed. Prints whether it did.
install_unit() {
  local tmp
  tmp=$(mktemp)
  render_unit >"$tmp"
  if [ -f "$UNIT_DST" ] && cmp -s "$tmp" "$UNIT_DST"; then
    ok "systemd unit $UNIT_DST is up to date"
  else
    sudo install -m 644 -o root -g root "$tmp" "$UNIT_DST"
    sudo systemctl daemon-reload
    ok "installed $UNIT_DST"
  fi
  rm -f "$tmp"
}

# 0 when the file exists, is owned by this user and has mode 600 (it is tightened to 600 when it is looser).
check_private_file() {
  local f="$1" mode owner
  [ -f "$f" ] || return 1
  owner=$(stat -c %U "$f")
  [ "$owner" = "$(id -un)" ] || die "$f belongs to $owner, not $(id -un). Fix it: sudo chown $(id -un): $f"
  mode=$(stat -c %a "$f")
  if [ "$mode" != "600" ]; then
    chmod 600 "$f"
    warn "$f had mode $mode; set to 600"
  fi
  return 0
}
