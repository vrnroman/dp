#!/usr/bin/env bash
# deployctl org profile — VM-side deploy. Run as root (via sudo) ON the target VM.
# It is idempotent and safe to re-run, and it protects whatever is already on the box
# (notably Membro on the apex domain): it backs up shared config before touching it,
# validates Caddy before every reload, and rolls back its own change if the front door
# stops answering.
#
# Args (positional, so they survive sudo):
#   $1 SLUG      url-safe app name (e.g. alive-demo)
#   $2 PORT      loopback port for the service (e.g. 8080)
#   $3 HOSTNAME  full public hostname (e.g. alive-demo.34-11-212-4.sslip.io)
#   $4 APEX      the front-door apex to protect (e.g. 34-11-212-4.sslip.io)
#   $5 APPUSER   the unix user that owns/runs the app (e.g. tianyuezhou)
set -euo pipefail

SLUG="${1:?slug required}"
PORT="${2:?port required}"
HOSTNAME_="${3:?hostname required}"
APEX="${4:?apex required}"
APPUSER="${5:?appuser required}"

HOME_DIR="/home/$APPUSER"
APPDIR="$HOME_DIR/dp-apps/$SLUG"
TGZ="$HOME_DIR/dp-$SLUG.tgz"
UNIT="/etc/systemd/system/dp-$SLUG.service"
CADDYFILE="/etc/caddy/Caddyfile"
CONFD="/etc/caddy/conf.d"
APPCADDY="$CONFD/dp-$SLUG.caddy"

log() { echo "DP> $*"; }
# A 2xx/3xx response counts as a healthy front door (Membro answers 302 to its login).
healthy() { case "$1" in 2*|3*) return 0 ;; *) return 1 ;; esac; }

# --- 0. Protect the front door: record whether the apex answers BEFORE we touch anything.
BEFORE=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 15 "https://$APEX" 2>/dev/null || echo 000)
log "front door ($APEX) before: $BEFORE"

# --- 1. Land the code.
log "placing the app under $APPDIR"
systemctl stop "dp-$SLUG" 2>/dev/null || true
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
tar xzf "$TGZ" -C "$APPDIR"
chown -R "$APPUSER:$APPUSER" "$HOME_DIR/dp-apps"

# --- 2. Install dependencies and build (as the app user, never as root).
if [ -f "$APPDIR/package.json" ]; then
  log "installing dependencies"
  sudo -u "$APPUSER" env HOME="$HOME_DIR" bash -c "cd '$APPDIR' && (/usr/bin/npm ci --no-audit --no-fund >/dev/null 2>&1 || /usr/bin/npm install --no-audit --no-fund)"
  if sudo -u "$APPUSER" node -e "const s=require('$APPDIR/package.json').scripts||{};process.exit(s.build?0:1)" 2>/dev/null; then
    log "building"
    sudo -u "$APPUSER" env HOME="$HOME_DIR" NODE_ENV=production bash -c "cd '$APPDIR' && /usr/bin/npm run build"
  fi
fi

# --- 3. Run it as a managed service (mirrors the hardened Membro unit: loopback, journald).
log "writing service dp-$SLUG (port $PORT)"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=dp:$SLUG (deployed by deployctl)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APPUSER
WorkingDirectory=$APPDIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=HOSTNAME=127.0.0.1
# Never let a deployed app silently bill an API key if one is present on the box.
Environment=ANTHROPIC_API_KEY=
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dp-$SLUG
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable "dp-$SLUG" >/dev/null 2>&1 || true
systemctl restart "dp-$SLUG"

# --- 4. Confirm the process is really listening before we route traffic to it.
UP=0
for _ in $(seq 1 45); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
  if [ "$CODE" != "000" ]; then UP=1; log "service answered locally ($CODE)"; break; fi
  sleep 1
done
if [ "$UP" != "1" ]; then
  log "ERROR: dp-$SLUG did not start. Recent logs:"
  journalctl -u "dp-$SLUG" -n 40 --no-pager 2>/dev/null || true
  exit 3
fi

# --- 5. Front door: enable the conf.d include once (backing up the shared file first),
#        then write THIS app's own site file. We never edit anyone else's block.
mkdir -p "$CONFD"
if ! grep -q 'import /etc/caddy/conf.d/\*\.caddy' "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.dpbak.$(date +%s)"
  printf '\n# Added by deployctl: per-app site files (one file per deployed app)\nimport /etc/caddy/conf.d/*.caddy\n' >> "$CADDYFILE"
  log "enabled per-app Caddy includes (original backed up)"
fi
cat > "$APPCADDY" <<CADDYEOF
$HOSTNAME_ {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDYEOF

# --- 6. Validate BEFORE reloading. If invalid, remove our file and stop (front door untouched).
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/dp-$SLUG-validate.log 2>&1; then
  log "ERROR: Caddy config invalid; removing this app's site file and leaving the front door as it was."
  cat "/tmp/dp-$SLUG-validate.log" || true
  rm -f "$APPCADDY"
  exit 4
fi
systemctl reload caddy

# --- 7. Confirm the front door still answers. If our change broke it, roll back our file.
AFTER=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 15 "https://$APEX" 2>/dev/null || echo 000)
log "front door ($APEX) after: $AFTER"
if healthy "$BEFORE" && ! healthy "$AFTER"; then
  log "ERROR: the front door went unhealthy after the reload ($BEFORE -> $AFTER). Rolling back this app's site file."
  rm -f "$APPCADDY"
  systemctl reload caddy || true
  exit 5
fi

rm -f "$TGZ"
log "RESULT url=https://$HOSTNAME_ port=$PORT service=dp-$SLUG"
