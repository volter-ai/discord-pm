#!/bin/sh
# Start the Discord bot and transcript web server as sibling processes.
# Both share the same /app/data volume for SQLite access.
set -e

echo "[entrypoint] Starting Discord bot..."
bun run src/index.ts &
BOT_PID=$!

echo "[entrypoint] Starting transcript web server..."
bun run src/web.ts &
WEB_PID=$!

# If either process exits, kill the other and exit with its code
wait_any() {
  wait -n 2>/dev/null || true
}

# Propagate SIGTERM/SIGINT to children
trap 'kill $BOT_PID $WEB_PID 2>/dev/null; exit 0' TERM INT

wait $BOT_PID $WEB_PID
