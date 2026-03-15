#!/bin/sh
# Start Discord-PM as a single process — bot + web server + Activity.
echo "[entrypoint] Starting Discord-PM..."
exec bun run src/index.ts
