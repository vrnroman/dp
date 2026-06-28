#!/usr/bin/env bash
# deployctl org profile — VM-side teardown. Run as root (via sudo) ON the target VM.
# Removes exactly what a deploy created for ONE app, and nothing else. The shared Caddy
# include line and any other app are left untouched; the front door is validated and
# only reloaded if still valid.
#
# Args: $1 SLUG   $2 APPUSER
set -euo pipefail

SLUG="${1:?slug required}"
APPUSER="${2:?appuser required}"

HOME_DIR="/home/$APPUSER"
APPDIR="$HOME_DIR/dp-apps/$SLUG"
UNIT="/etc/systemd/system/dp-$SLUG.service"
CADDYFILE="/etc/caddy/Caddyfile"
APPCADDY="/etc/caddy/conf.d/dp-$SLUG.caddy"

log() { echo "DP> $*"; }

log "stopping service dp-$SLUG"
systemctl disable --now "dp-$SLUG" 2>/dev/null || true
rm -f "$UNIT"
systemctl daemon-reload

if [ -f "$APPCADDY" ]; then
  log "removing the app's front-door entry"
  rm -f "$APPCADDY"
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy || true
  else
    log "WARN: Caddy config did not validate after removal; left as-is for inspection."
  fi
fi

rm -rf "$APPDIR"
log "RESULT removed=dp-$SLUG"
