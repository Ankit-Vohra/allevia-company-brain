#!/bin/sh
# Deploys this checkout to the public server (the hackathon judges' instance, docs/product-plan-after-hackathon.md 3.3):
#   scripts/ops/deploy-public.sh [ssh-host]        (default: allevia-dev)
# Copies the code only: never data/, models/, secrets, git history or local builds, so the founder's real businesses and keys
# stay on the Mac. The server keeps its own settings in ~/.config/allevia/allevia.env (its own FalkorDB, accounts on, billing
# in test mode), its own data folder, and the models copied once. Then it installs, builds the web app and restarts the server.
set -eu
HOST="${1:-allevia-dev}"
cd "$(dirname "$0")/../.."

rsync -az --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'web/node_modules/' --exclude 'site/node_modules/' \
  --exclude 'data/' --exclude 'models/' --exclude '.cache/' --exclude '.claude/' \
  --exclude 'web/dist/' --exclude 'site/dist*/' --exclude 'coverage/' \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' --exclude '*.log' \
  --exclude 'docs/research/' --exclude 'docs/creative-live/' --exclude 'docs/screenshots/' \
  ./ "$HOST":jarvis/

ssh "$HOST" 'set -eu
cd ~/jarvis
npm ci --no-audit --no-fund --loglevel=error
(cd web && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)
sudo systemctl restart allevia-server
sleep 8
systemctl is-active allevia-server
curl -s --max-time 10 http://127.0.0.1:8787/api/health; echo'
