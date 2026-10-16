#!/bin/sh
# Nightly backup of the real tenants' FalkorDB (container allevia-falkordb, volume allevia-falkordb-data).
# Asks the server to SAVE, checks the snapshot with redis-check-rdb, and keeps the last 7 good copies in
# ~/allevia-db-backups/nightly. A snapshot that fails the check is kept aside and never rotated in.
set -eu
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
DIR="$HOME/allevia-db-backups/nightly"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
docker exec allevia-falkordb redis-cli SAVE >/dev/null
docker run --rm -v allevia-falkordb-data:/d:ro -v "$DIR":/o alpine cp /d/dump.rdb "/o/dump-$STAMP.rdb"
if docker run --rm --entrypoint sh -v "$DIR":/o falkordb/falkordb:6.0.2 -c "redis-check-rdb /o/dump-$STAMP.rdb" 2>&1 | grep -q "RDB looks OK"; then
  echo "$STAMP ok" >> "$DIR/backup.log"
  ls -1t "$DIR"/dump-*.rdb | tail -n +8 | xargs rm -f
else
  mv "$DIR/dump-$STAMP.rdb" "$DIR/BAD-dump-$STAMP.rdb"
  echo "$STAMP FAILED integrity check" >> "$DIR/backup.log"
  exit 1
fi
