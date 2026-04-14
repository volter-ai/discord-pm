#!/usr/bin/env bash
# Guarded wrapper around `fly deploy`.
#
# Aborts if an in-memory standup/meeting session is active on the remote,
# so a rolling restart doesn't kill a live recording. Pass --force to skip.
#
# Usage:
#   scripts/deploy.sh [--force] [extra fly deploy args...]
#
# Env:
#   WEB_PASSWORD   Basic-auth password for the /internal endpoint (required
#                  unless --force).
#   DEPLOY_URL     Override the default https://discord-pm.fly.dev.

set -euo pipefail

FORCE=0
FLY_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    FORCE=1
  else
    FLY_ARGS+=("$arg")
  fi
done

URL="${DEPLOY_URL:-https://discord-pm.fly.dev}/internal/active-sessions"

if [[ $FORCE -eq 0 ]]; then
  if [[ -z "${WEB_PASSWORD:-}" ]]; then
    echo "error: WEB_PASSWORD is not set — either export it or pass --force" >&2
    exit 2
  fi

  echo "[deploy] Checking for active sessions at $URL"
  body=$(curl -sS --fail --max-time 10 -u ":$WEB_PASSWORD" "$URL") || {
    echo "error: could not reach $URL (pass --force to deploy anyway)" >&2
    exit 3
  }

  count=$(printf '%s' "$body" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("sessions", [])))')

  if [[ "$count" -gt 0 ]]; then
    echo "[deploy] $count active session(s) — restart would drop them:"
    printf '%s' "$body" | python3 -m json.tool >&2
    echo "[deploy] aborting. Re-run with --force to deploy anyway." >&2
    exit 1
  fi

  echo "[deploy] No active sessions. Proceeding with fly deploy."
fi

exec fly deploy "${FLY_ARGS[@]}"
