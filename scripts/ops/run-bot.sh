#!/bin/sh
# Keeps the Allevia Discord bot running (issue #28): the hub bot when DISCORD_HUB_GUILD_ID is set, else the demo bot.
# Restarts it whenever it exits and logs to ~/allevia-logs/bot.log. Extra arguments go to `cli discord`
# (for example --tenant aamdani, --demo, --model haiku).
#   scripts/ops/run-bot.sh [--tenant aamdani] [--demo]
set -eu
cd "$(dirname "$0")/../.."
exec scripts/ops/supervise.sh "${ALLEVIA_BOT_LOG_NAME:-bot}" node_modules/.bin/tsx src/cli.ts discord "$@"
