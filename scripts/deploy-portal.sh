#!/usr/bin/env bash
# Deploy the portal onto the VM from the owner's laptop. One-time-ish infra setup:
# packs the repo, ships it, and runs the VM-side bootstrap which gates it behind basic_auth.
#
# Env (optional): DP_VM_INSTANCE, DP_VM_PROJECT, DP_VM_ZONE, DP_VM_IP, DP_VM_USER, PORTAL_USER, PORTAL_PASS
set -euo pipefail

INSTANCE="${DP_VM_INSTANCE:-claude-agent}"
PROJECT="${DP_VM_PROJECT:-roman-vm}"
ZONE="${DP_VM_ZONE:-us-west1-a}"
IP="${DP_VM_IP:-34.11.212.4}"
USER_="${DP_VM_USER:-tianyuezhou}"
APEX="${IP//./-}.sslip.io"
HOSTNAME_="portal.$APEX"
PORT="${PORTAL_PORT:-8090}"
GATE_USER="${PORTAL_USER:-owner}"
# Empty by default: a redeploy PRESERVES the portal's existing login. Set PORTAL_PASS to rotate
# it. The VM-side bootstrap mints one only on the very first deploy and prints it then.
GATE_PASS="${PORTAL_PASS:-}"

# Optional: the portal's own Google sign-in. Set BOTH to gate the portal with Google instead of
# the shared basic_auth password. The redirect to register in the Google console is:
#   https://$HOSTNAME_/auth/google/callback
# PORTAL_ALLOWED_EMAILS (comma-separated) optionally restricts who may sign in (default: anyone).
PGCID="${PORTAL_GOOGLE_CLIENT_ID:-}"
PGCSECRET="${PORTAL_GOOGLE_CLIENT_SECRET:-}"
PALLOW="${PORTAL_ALLOWED_EMAILS:-}"
# The portal runs code on your VM, so it is fail-closed: with no allowed-emails it admits NOBODY.
# Set PORTAL_OPEN=1 to deliberately let anyone with a Google account in (not recommended here).
POPEN="${PORTAL_OPEN:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
TGZ="$WORK/dp-portal-repo.tgz"

echo "Packing the repo..."
tar czf "$TGZ" \
  --exclude=node_modules --exclude=.git --exclude=.next --exclude=.vercel \
  --exclude='.deploy-state.json' --exclude='*-card.html' \
  -C "$ROOT" .

# Build the Google env file when configured. A stable PORTAL_AUTH_SECRET keeps sessions valid
# across restarts; we generate one if the owner did not supply it. This file (with the client
# secret) is shipped over scp, never passed on the command line.
SCP_LIST=("$TGZ" "$ROOT/scripts/portal-bootstrap.sh")
GOOGLE_NOTE="off (shared password)"
if [ -n "$PGCID" ] && [ -n "$PGCSECRET" ]; then
  PAUTH="${PORTAL_AUTH_SECRET:-$(openssl rand -hex 32)}"
  ENVFILE="$WORK/dp-portal.env"
  cat > "$ENVFILE" <<EOF
PORTAL_GOOGLE_CLIENT_ID=$PGCID
PORTAL_GOOGLE_CLIENT_SECRET=$PGCSECRET
PORTAL_AUTH_SECRET=$PAUTH
PORTAL_BASE_URL=https://$HOSTNAME_
PORTAL_ALLOWED_EMAILS=$PALLOW
PORTAL_OPEN=$POPEN
EOF
  SCP_LIST+=("$ENVFILE")
  GOOGLE_NOTE="ON (portal Google sign-in + the auth relay, so every deployed app gets Google sign-in with no per-app setup; register https://$HOSTNAME_/auth/google/callback in the Google console)"
  if [ -z "$PALLOW" ] && [ "$POPEN" != "1" ]; then
    echo "WARNING: Google sign-in is on but PORTAL_ALLOWED_EMAILS is empty. The portal is fail-closed:"
    echo "         NOBODY will be able to sign in until you set PORTAL_ALLOWED_EMAILS=you@gmail.com"
    echo "         (or PORTAL_OPEN=1 to intentionally allow anyone). Deploying anyway."
  fi
fi

echo "Shipping to ${INSTANCE}... (portal Google sign-in: $GOOGLE_NOTE)"
gcloud compute scp "${SCP_LIST[@]}" \
  "$INSTANCE:/home/$USER_/" --project "$PROJECT" --zone "$ZONE" >/dev/null

echo "Bootstrapping the portal on the VM..."
gcloud compute ssh "$INSTANCE" --project "$PROJECT" --zone "$ZONE" --command \
  "sudo bash /home/$USER_/portal-bootstrap.sh '$PORT' '$HOSTNAME_' '$APEX' '$USER_' '$GATE_USER' '$GATE_PASS'"

echo ""
echo "================ PORTAL READY ================"
echo "URL:      https://$HOSTNAME_"
echo "Username: $GATE_USER"
if [ -n "$GATE_PASS" ]; then
  echo "Password: $GATE_PASS"
else
  echo "Password: unchanged (preserved). First deploy mints one — see 'NEW PASSWORD' above."
  echo "          To rotate it: PORTAL_PASS=your-pass bash scripts/deploy-portal.sh"
fi
echo "============================================="
