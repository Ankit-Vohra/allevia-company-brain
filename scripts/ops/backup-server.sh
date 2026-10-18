#!/bin/sh
# Nightly backup on the server (allevia-dev), run by the systemd timer allevia-backup.timer:
#   1. a snapshot of the whole FalkorDB (SAVE, then redis-check-rdb must say it is good);
#   2. every business's graph exported on its own (db:export, readable and restorable one business at a time);
#   3. the app's data folder (uploads, Studio pictures, sealed connection records).
# Everything goes to S3 (private, encrypted, deleted after 35 days by the bucket's own rule; the server may add and read
# backups but never delete them), and the last 7 nights stay on the server's disk.
set -eu
BUCKET="${ALLEVIA_BACKUP_BUCKET:?set ALLEVIA_BACKUP_BUCKET (the server sets it in allevia-backup.service)}"
REGION="${AWS_REGION:-ap-south-1}"
DB="${ALLEVIA_DB_CONTAINER:-allevia-falkordb-1}"
DATA="${ALLEVIA_DATA_DIR:-$HOME/allevia-public/data}"
DIR="$HOME/allevia-db-backups/nightly"
PASS_FILE="$HOME/.config/allevia/falkordb.pass"
STAMP=$(date -u +%Y%m%d-%H%M%S)
DAY=$(date -u +%Y-%m-%d)
OUT="$DIR/$STAMP"
mkdir -p "$OUT"
cd "$(dirname "$0")/../.."
log() { echo "$STAMP $*" >> "$DIR/backup.log"; echo "$*"; }

AUTH=""
[ -f "$PASS_FILE" ] && AUTH="$(cat "$PASS_FILE")"
cli() { docker exec -e REDISCLI_AUTH="$AUTH" "$DB" redis-cli "$@"; }

# 1. the whole database
cli SAVE >/dev/null
docker cp "$DB:/var/lib/falkordb/data/dump.rdb" "$OUT/dump.rdb"
if docker exec "$DB" redis-check-rdb /var/lib/falkordb/data/dump.rdb 2>&1 | grep -q "RDB looks OK"; then log "snapshot ok"; else log "snapshot FAILED its check"; mv "$OUT/dump.rdb" "$OUT/BAD-dump.rdb"; fi

# 2. each business on its own (projection graphs, named with "__", are caches and are skipped)
for g in $(cli GRAPH.LIST | grep '^allevia_' | grep -v '__'); do
  t="${g#allevia_}"
  # allevia_reference is shared know-how, not a business (its name is reserved, so db:export refuses it): it is in the
  # snapshot above and is rebuilt from the repo's playbook data.
  if [ "$t" = "reference" ]; then log "reference graph: in the snapshot"; continue; fi
  if npm run -s cli -- db:export "$t" "$OUT/$t.jsonl" >/dev/null 2>&1; then log "export $t ok"; else log "export $t FAILED"; fi
done

# 3. the data folder
[ -d "$DATA" ] && tar -C "$(dirname "$DATA")" -czf "$OUT/data.tgz" "$(basename "$DATA")" && log "data folder ok"

gzip -f "$OUT"/*.jsonl "$OUT"/*.rdb 2>/dev/null || true
if aws s3 cp --recursive --only-show-errors "$OUT" "s3://$BUCKET/$DAY/$STAMP/" --region "$REGION"; then log "uploaded to s3://$BUCKET/$DAY/$STAMP/"; else log "upload FAILED"; exit 1; fi
ls -1d "$DIR"/2* | sort | head -n -7 | xargs rm -rf
