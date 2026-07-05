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
# May be empty. Empty means: preserve the portal's existing login on a redeploy (and only mint
# a fresh password on the very first deploy). A non-empty value sets/rotates the password.
GATE_PASS="${6-}"

HOME_DIR="/home/$APPUSER"
REPO="$HOME_DIR/deployment-platform"
TGZ="$HOME_DIR/dp-portal-repo.tgz"
UNIT="/etc/systemd/system/dp-portal.service"
CADDYFILE="/etc/caddy/Caddyfile"
CONFD="/etc/caddy/conf.d"
APPCADDY="$CONFD/dp-portal.caddy"
# The portal's own Google sign-in, when configured. deploy-portal.sh ships a dp-portal.env with
# the PORTAL_GOOGLE_* keys next to the repo tarball; we install it to /etc/dp-portal.env (0600)
# and the service reads it. When it names a Google client, the portal gates itself with Google and
# Caddy drops basic_auth; otherwise the shared-password front door stays exactly as before.
ENV_SHIPPED="$HOME_DIR/dp-portal.env"
ENV_INSTALLED="/etc/dp-portal.env"
# GOOGLE_ON must match the node gate's own `enabled` predicate EXACTLY (it needs BOTH a client id
# AND a secret). If we keyed off the id alone, a file with the id but no secret would drop Caddy's
# basic_auth while the gate stayed disabled — leaving the deploy console open to the internet.
GOOGLE_ON=0
if [ -f "$ENV_SHIPPED" ] \
  && grep -q '^PORTAL_GOOGLE_CLIENT_ID=..*' "$ENV_SHIPPED" \
  && grep -q '^PORTAL_GOOGLE_CLIENT_SECRET=..*' "$ENV_SHIPPED"; then
  GOOGLE_ON=1
fi

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

# Install the Google sign-in env file, if one was shipped. Root-owned and 0600: it holds the
# portal's OAuth client secret, so it is never world-readable and never inside the repo tree.
if [ "$GOOGLE_ON" = "1" ]; then
  install -m 600 -o root -g root "$ENV_SHIPPED" "$ENV_INSTALLED"
  rm -f "$ENV_SHIPPED"
  log "portal Google sign-in: configured (front door will use Google, not the shared password)"

  # Auth relay: stand up the shared relay so EVERY deployed app gets Google sign-in with no
  # per-app Google-console step. The signing key + admin secret are generated ONCE and preserved
  # (rotating the key would invalidate every deployed app's held public key).
  RELAY_KEY=/etc/dp-relay-key.pem
  RELAY_PUB=/etc/dp-relay-pub.json
  RELAY_KIDF=/etc/dp-relay-kid
  RELAY_ADMINF=/etc/dp-relay-admin.secret
  RELAY_ALLOWDIR=/var/lib/dp-relay
  RELAY_ALLOW="$RELAY_ALLOWDIR/allow.txt"
  RELAY_STORE="$RELAY_ALLOWDIR/store.json"
  mkdir -p "$RELAY_ALLOWDIR"
  touch "$RELAY_ALLOW"
  # The DP central groups store (apps / people / groups / memberships / mappings). Create it
  # valid-but-empty on the first deploy; a redeploy PRESERVES it (never clobber the owner's org
  # graph). The store writes atomically (temp file + rename) and rotates backups IN this dir, so
  # the dir itself must be app-user-owned (chowned below), not just the file.
  [ -f "$RELAY_STORE" ] || echo '{"version":1,"apps":{},"people":{},"groups":{},"members":{},"appRoles":{}}' > "$RELAY_STORE"
  # Generate the key as root (we are root here; /etc is root-owned), then hand ownership to the
  # app user so the node service can read it at runtime.
  RELAY_KID=$(/usr/bin/node "$REPO/apps/portal/relay-keygen.js" "$RELAY_KEY" "$RELAY_PUB" "$RELAY_KIDF")
  if [ ! -f "$RELAY_ADMINF" ]; then openssl rand -hex 24 > "$RELAY_ADMINF"; chmod 600 "$RELAY_ADMINF"; fi
  RELAY_ADMIN=$(cat "$RELAY_ADMINF")
  # The node service (running as $APPUSER) reads the private key, public key, and allowlist at
  # runtime, and READ-WRITES the groups store. Hand it the store DIR (so atomic temp-file writes and
  # backup rotation can create files in it) plus the store file and the relay key material.
  chown "$APPUSER:$APPUSER" "$RELAY_ALLOWDIR" "$RELAY_STORE" "$RELAY_KEY" "$RELAY_PUB" "$RELAY_ALLOW" "$RELAY_KIDF"
  chmod 600 "$RELAY_KEY"
  # Append the relay config to the service env (idempotent: strip any prior relay lines first). The
  # keys are passed as FILE PATHS (a multi-line PEM and a JSON JWK do not belong inline in an env file).
  sed -i '/^PORTAL_RELAY_/d; /^DP_RELAY_/d' "$ENV_INSTALLED"
  cat >> "$ENV_INSTALLED" <<RELAYEOF
PORTAL_RELAY_PRIVATE_KEY_FILE=$RELAY_KEY
PORTAL_RELAY_PUBLIC_KEY_FILE=$RELAY_PUB
PORTAL_RELAY_KID=$RELAY_KID
PORTAL_RELAY_ISSUER=dp-relay
PORTAL_RELAY_ADMIN_SECRET=$RELAY_ADMIN
PORTAL_RELAY_ALLOW_FILE=$RELAY_ALLOW
DP_RELAY_URL=https://$HOSTNAME_
DP_RELAY_ADMIN_TOKEN=$RELAY_ADMIN
DP_RELAY_ISSUER=dp-relay
RELAYEOF
  chmod 600 "$ENV_INSTALLED"
  log "auth relay: provisioned (kid $RELAY_KID); deployed apps get Google sign-in with no setup"
else
  log "portal Google sign-in: not configured (front door stays on the shared password)"
fi

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
# Optional: the portal's Google sign-in config. The leading '-' makes it a no-op when absent,
# so a portal without Google configured starts exactly as before.
EnvironmentFile=-$ENV_INSTALLED
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

# The front door. Two mutually exclusive modes:
#  - Google on: the portal handles sign-in itself (it redirects anyone not signed in), so Caddy
#    must NOT also basic_auth or the person would be asked for a password before ever reaching the
#    Google button. Caddy just proxies; the node gate is the door.
#  - Google off (default): Caddy basic_auth is the door, exactly as before. A routine redeploy must
#    not change how the owner signs in, so a blank password preserves the existing one and only the
#    first deploy mints a fresh one.
PASS_NOTE=""
NEW_PASS=""
if [ "$GOOGLE_ON" = "1" ]; then
  PASS_NOTE="front door is Google sign-in (basic_auth off)"
  cat > "$APPCADDY" <<CADDYEOF
$HOSTNAME_ {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDYEOF
else
  if [ -n "$GATE_PASS" ]; then
    AUTHLINE="$GATE_USER $(caddy hash-password --plaintext "$GATE_PASS")"
    PASS_NOTE="login set from PORTAL_PASS"
  elif [ -f "$APPCADDY" ] && grep -q 'basic_auth' "$APPCADDY"; then
    AUTHLINE=$(awk '/basic_auth[[:space:]]*\{/{getline; sub(/^[[:space:]]+/,""); sub(/[[:space:]]+$/,""); print; exit}' "$APPCADDY")
    if [ -n "$AUTHLINE" ]; then
      PASS_NOTE="login preserved (unchanged)"
    else
      NEW_PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)
      AUTHLINE="$GATE_USER $(caddy hash-password --plaintext "$NEW_PASS")"
      PASS_NOTE="login reset (previous one could not be read)"
    fi
  else
    NEW_PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)
    AUTHLINE="$GATE_USER $(caddy hash-password --plaintext "$NEW_PASS")"
    PASS_NOTE="login created (first deploy)"
  fi

  cat > "$APPCADDY" <<CADDYEOF
$HOSTNAME_ {
	basic_auth {
		$AUTHLINE
	}
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
CADDYEOF
fi

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
log "auth: $PASS_NOTE"
if [ -n "$NEW_PASS" ]; then
  log "NEW PASSWORD (save it; it will be preserved on future redeploys): $NEW_PASS"
fi
log "RESULT url=https://$HOSTNAME_ port=$PORT service=dp-portal user=$GATE_USER pass=${NEW_PASS:-<unchanged>}"
