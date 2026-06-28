#!/usr/bin/env bash
# deployctl portal — VM-side bootstrap. Run as root (via sudo) ON the target VM.
# Installs the deployment-platform repo, runs the portal as a managed service, and puts it
# behind an HTTPS basic-auth gate (the portal clones and runs code, so it must never be open).
# Idempotent and front-door-safe, exactly like the app deploy script.
#
# Args: $1 PORT  $2 HOSTNAME  $3 APEX  $4 APPUSER  $5 GATE_USER  $6 GATE_PASS
set -euo pipefail

PORT="${1:?port}"
HOSTNAME_="${2:?hostname}"
APEX="${3:?apex}"
APPUSER="${4:?appuser}"
GATE_USER="${5:?gate user}"
GATE_PASS="${6:?gate pass}"

HOME_DIR="/home/$APPUSER"
REPO="$HOME_DIR/deployment-platform"
TGZ="$HOME_DIR/dp-portal-repo.tgz"
UNIT="/etc/systemd/system/dp-portal.service"
CADDYFILE="/etc/caddy/Caddyfile"
CONFD="/etc/caddy/conf.d"
APPCADDY="$CONFD/dp-portal.caddy"

log() { echo "DP> $*"; }
healthy() { case "$1" in 2*|3*) return 0 ;; *) return 1 ;; esac; }

BEFORE=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 15 "https://$APEX" 2>/dev/null || echo 000)
log "front door ($APEX) before: $BEFORE"

log "installing the platform repo under $REPO"
rm -rf "$REPO"
mkdir -p "$REPO"
tar xzf "$TGZ" -C "$REPO"
chown -R "$APPUSER:$APPUSER" "$REPO"

log "installing dependencies (this can take a minute)"
sudo -u "$APPUSER" env HOME="$HOME_DIR" bash -c "cd '$REPO' && /usr/bin/npm install --no-audit --no-fund"

log "writing service dp-portal (port $PORT)"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=dp:portal (the deployment portal)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APPUSER
WorkingDirectory=$REPO/apps/portal
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DP_TARGET=local
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=ANTHROPIC_API_KEY=
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dp-portal

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable dp-portal >/dev/null 2>&1 || true
systemctl restart dp-portal

UP=0
for _ in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then UP=1; log "portal answered locally ($CODE)"; break; fi
  sleep 1
done
if [ "$UP" != "1" ]; then
  log "ERROR: portal did not start. Recent logs:"
  journalctl -u dp-portal -n 40 --no-pager 2>/dev/null || true
  exit 3
fi

# Front door: enable conf.d include (backup once), then write the GATED site file.
mkdir -p "$CONFD"
if ! grep -q 'import /etc/caddy/conf.d/\*\.caddy' "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.dpbak.$(date +%s)"
  printf '\n# Added by deployctl: per-app site files\nimport /etc/caddy/conf.d/*.caddy\n' >> "$CADDYFILE"
  log "enabled per-app Caddy includes (original backed up)"
fi

HASH=$(caddy hash-password --plaintext "$GATE_PASS")
cat > "$APPCADDY" <<CADDYEOF
$HOSTNAME_ {
	basic_auth {
		$GATE_USER $HASH
	}
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDYEOF

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/dp-portal-validate.log 2>&1; then
  log "ERROR: Caddy config invalid; removing portal site file."
  cat /tmp/dp-portal-validate.log || true
  rm -f "$APPCADDY"
  exit 4
fi
systemctl reload caddy

AFTER=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 15 "https://$APEX" 2>/dev/null || echo 000)
log "front door ($APEX) after: $AFTER"
if healthy "$BEFORE" && ! healthy "$AFTER"; then
  log "ERROR: front door went unhealthy after reload ($BEFORE -> $AFTER); rolling back portal site file."
  rm -f "$APPCADDY"
  systemctl reload caddy || true
  exit 5
fi

rm -f "$TGZ"
log "RESULT url=https://$HOSTNAME_ port=$PORT service=dp-portal"
