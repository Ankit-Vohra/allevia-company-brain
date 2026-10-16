#!/bin/sh
# A tiny supervisor (issue #28): runs one Allevia process and starts it again whenever it exits, so a crash or a
# database restart never leaves the bot or the server down. Output goes to ~/allevia-logs/<name>.log (ALLEVIA_LOG_DIR
# to change it); a log over 50 MB is moved to <name>.log.1. A process that keeps dying quickly is restarted with a
# growing pause (2 s up to 60 s), back to 2 s once it has stayed up for 5 minutes. Ctrl-C or SIGTERM stops the process
# and the supervisor. ALLEVIA_SUPERVISE_MAX_RUNS stops after that many runs (tests).
#   scripts/ops/supervise.sh <name> <command> [args...]
# Used by run-bot.sh and run-server.sh.
set -u
[ $# -ge 2 ] || { echo "usage: $0 <name> <command> [args...]" >&2; exit 2; }
NAME=$1; shift
LOG_DIR=${ALLEVIA_LOG_DIR:-"$HOME/allevia-logs"}
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$NAME.log"
MAX_LOG_BYTES=52428800
MAX_RUNS=${ALLEVIA_SUPERVISE_MAX_RUNS:-0}
PAUSE_START=${ALLEVIA_SUPERVISE_PAUSE:-2}
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') [supervise:$NAME] $*" >> "$LOG"; }

child=""
stopping=0
stop() {
  stopping=1
  say "stop requested"
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
}
trap stop INT TERM

pause=$PAUSE_START
runs=0
while [ "$stopping" -eq 0 ]; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt "$MAX_LOG_BYTES" ]; then mv "$LOG" "$LOG.1"; fi
  say "starting: $*"
  started=$(date +%s)
  "$@" >> "$LOG" 2>&1 &
  child=$!
  # wait returns early when a signal arrives; wait again so the process is reaped once it has stopped
  wait "$child"; code=$?
  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
  child=""
  runs=$((runs + 1))
  [ "$stopping" -eq 1 ] && break
  up=$(( $(date +%s) - started ))
  if [ "$MAX_RUNS" -gt 0 ] && [ "$runs" -ge "$MAX_RUNS" ]; then say "exited with code $code after ${up}s; run limit reached"; break; fi
  [ "$up" -ge 300 ] && pause=$PAUSE_START
  say "exited with code $code after ${up}s; starting again in ${pause}s"
  sleep "$pause" &
  wait $! 2>/dev/null
  pause=$((pause * 2)); [ "$pause" -gt 60 ] && pause=60
done
say "stopped"
