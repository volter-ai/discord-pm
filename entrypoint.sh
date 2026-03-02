#!/bin/sh
# Start the Discord bot and transcript web server as sibling processes.
# Both share the same /app/data volume for SQLite access.
# Note: do NOT use set -e here — the bot crashing must not kill the web server.

echo "[entrypoint] Starting Discord bot..."
bun run src/index.ts &
BOT_PID=$!

echo "[entrypoint] Starting transcript web server..."
bun run src/web.ts &
WEB_PID=$!

# Propagate SIGTERM/SIGINT to children
trap 'kill $BOT_PID $WEB_PID 2>/dev/null; exit 0' TERM INT

# Wait for the web server (primary process for fly health checks).
# If the web server exits, kill the bot and exit.
wait $WEB_PID
WEB_EXIT=$?
kill $BOT_PID 2>/dev/null
exit $WEB_EXIT
