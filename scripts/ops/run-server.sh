#!/bin/sh
# Keeps the Allevia server (the API and the web app) running (issue #28). Restarts it whenever it exits and logs to
# ~/allevia-logs/server.log. Extra arguments go to `cli serve` (for example --port 8788, --public, --api-only).
#   scripts/ops/run-server.sh [--port 8787]
set -eu
cd "$(dirname "$0")/../.."
exec scripts/ops/supervise.sh "${ALLEVIA_SERVER_LOG_NAME:-server}" node_modules/.bin/tsx src/cli.ts serve "$@"
