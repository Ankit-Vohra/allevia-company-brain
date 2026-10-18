#!/bin/sh
# Nightly backup of the real tenants' FalkorDB (container allevia-falkordb, volume allevia-falkordb-data).
# Asks the server to SAVE, checks the snapshot with redis-check-rdb, and keeps the last 7 good copies in
# ~/allevia-db-backups/nightly. A snapshot that fails the check is kept aside and never rotated in.
set -eu
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DIR="$HOME/allevia-db-backups/nightly"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
if docker ps --format '{{.Names}}' | grep -qx allevia-falkordb; then
docker exec allevia-falkordb redis-cli SAVE >/dev/null
docker run --rm -v allevia-falkordb-data:/d:ro -v "$DIR":/o alpine cp /d/dump.rdb "/o/dump-$STAMP.rdb"
if docker run --rm --entrypoint sh -v "$DIR":/o falkordb/falkordb:6.0.2 -c "redis-check-rdb /o/dump-$STAMP.rdb" 2>&1 | grep -q "RDB looks OK"; then
  echo "$STAMP ok" >> "$DIR/backup.log"
  ls -1t "$DIR"/dump-*.rdb | tail -n +8 | xargs rm -f
else
  mv "$DIR/dump-$STAMP.rdb" "$DIR/BAD-dump-$STAMP.rdb"
  echo "$STAMP FAILED integrity check" >> "$DIR/backup.log"
fi
else
  echo "$STAMP local DB not running (live data is on FalkorDB Cloud); local snapshot skipped" >> "$DIR/backup.log"
fi

# Since 2026-10-16 the live data is on FalkorDB Cloud (free tier: no backups of its own). Export each graph from the
# cloud every night too, keeping the last 7 nights per graph.
cd "$(dirname "$0")/../.."
for t in meta aamdani avs_atelier demo_seed; do
  if npm run -s cli -- db:export "$t" "$DIR/cloud-$t-$STAMP.jsonl" --from env:ALLEVIA_FALKORDB_CLOUD_URL >/dev/null 2>&1; then
    echo "$STAMP cloud $t ok" >> "$DIR/backup.log"
    ls -1t "$DIR"/cloud-"$t"-*.jsonl | tail -n +8 | xargs rm -f
  else
    echo "$STAMP cloud $t FAILED" >> "$DIR/backup.log"
  fi
done
