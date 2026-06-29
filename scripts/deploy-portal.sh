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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TGZ="$(mktemp -d)/dp-portal-repo.tgz"

echo "Packing the repo..."
tar czf "$TGZ" \
  --exclude=node_modules --exclude=.git --exclude=.next --exclude=.vercel \
  --exclude='.deploy-state.json' --exclude='*-card.html' \
  -C "$ROOT" .

echo "Shipping to ${INSTANCE}..."
gcloud compute scp "$TGZ" "$ROOT/scripts/portal-bootstrap.sh" \
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
