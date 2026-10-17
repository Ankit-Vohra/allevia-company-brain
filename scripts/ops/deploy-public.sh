#!/bin/sh
# Deploys this checkout to the public server (the hackathon judges' instance, docs/product-plan-after-hackathon.md 3.3):
#   scripts/ops/deploy-public.sh [ssh-host]        (default: allevia-dev)
# Copies the code only: never data/, models/, secrets, git history or local builds, so the founder's real businesses and keys
# stay on the Mac. The server keeps its own settings in ~/.config/allevia/allevia.env (its own FalkorDB, accounts on, billing
# in test mode), its own data folder, and the models copied once. Its FalkorDB has a password: start it only with
# ~/allevia-public/falkordb.override.yml (see that file), never with the plain docker-compose.yml.
#
# The running app is never touched while the new one is prepared (17 Oct: reinstalling packages in place broke a live
# question for a minute): the new version is built in ~/jarvis-next, packages are reinstalled only when package-lock.json
# changed, then the folders swap in one step and the server restarts (a few seconds). If it does not come back healthy the
# old folder is put back and restarted.
set -eu
HOST="${1:-allevia-dev}"
cd "$(dirname "$0")/../.."

ssh "$HOST" 'set -eu; rm -rf ~/jarvis-next; cp -a ~/jarvis ~/jarvis-next'

rsync -az --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'web/node_modules/' --exclude 'site/node_modules/' \
  --exclude 'data/' --exclude 'models/' --exclude '.cache/' --exclude '.claude/' \
  --exclude 'web/dist/' --exclude 'site/dist*/' --exclude 'coverage/' \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' --exclude '*.key' --exclude '*.log' \
  --exclude 'docs/research/' --exclude 'docs/creative-live/' --exclude 'docs/screenshots/' \
  ./ "$HOST":jarvis-next/

ssh "$HOST" 'set -eu
cd ~/jarvis-next
same() { cmp -s "$HOME/jarvis/$1" "$HOME/jarvis-next/$1"; }
if same package-lock.json; then echo "packages unchanged"; else npm ci --no-audit --no-fund --loglevel=error; fi
if same web/package-lock.json; then :; else (cd web && npm ci --no-audit --no-fund --loglevel=error); fi
(cd web && npm run build >/dev/null)
rm -rf ~/jarvis-prev
mv ~/jarvis ~/jarvis-prev && mv ~/jarvis-next ~/jarvis
sudo systemctl restart allevia-server
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 2; if curl -sf --max-time 5 http://127.0.0.1:8787/api/health >/dev/null; then break; fi; done
if curl -sf --max-time 5 http://127.0.0.1:8787/api/health; then echo; echo "deployed"; else
  echo "the new version did not come up: putting the old one back"
  mv ~/jarvis ~/jarvis-failed && mv ~/jarvis-prev ~/jarvis && sudo systemctl restart allevia-server
  exit 1
fi'
