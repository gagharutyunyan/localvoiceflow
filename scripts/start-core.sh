#!/usr/bin/env bash
#
# Starts the LocalVoiceFlow core if it is not already listening.
#
# This file is a template: scripts/build.sh substitutes the @@...@@ placeholders
# with absolute paths and copies the result into
# LocalVoiceFlow.app/Contents/Resources/start-core.sh. An app launched from Finder
# or from launchd inherits none of the login shell's PATH, so nothing here may
# rely on a lookup. Kept standalone on purpose — it must work from inside the
# bundle, with the repository absent from PATH and _lib.sh out of reach.
set -euo pipefail

REPO_ROOT="${LVF_REPO_ROOT:-@@REPO_ROOT@@}"
NODE_BIN="${LVF_NODE:-@@NODE_BIN@@}"
PORT="${LVF_PORT:-@@PORT@@}"

# Running the template directly out of the repository, before any substitution.
case "$REPO_ROOT" in
  *@@*) REPO_ROOT="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)" ;;
esac
case "$NODE_BIN" in
  *@@*) NODE_BIN="$(command -v node || true)" ;;
esac
case "$PORT" in
  *@@* | '') PORT=43117 ;;
esac

APP_NAME="LocalVoiceFlow"
DATA_DIR="$HOME/Library/Application Support/$APP_NAME"
LOGS_DIR="$HOME/Library/Logs/$APP_NAME"
PID_FILE="$DATA_DIR/core.pid"
LOG_FILE="$LOGS_DIR/core.log"
ENTRY="$REPO_ROOT/apps/core/dist/main.js"
BASE_URL="http://127.0.0.1:$PORT"

log() { printf '[start-core] %s\n' "$*" >&2; }

healthy() { curl -fsS -m 2 "$BASE_URL/api/health" >/dev/null 2>&1; }

if healthy; then
  log "core already listening on $PORT"
  exit 0
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  log "node not found (looked at: ${NODE_BIN:-<unset>})"
  exit 1
fi

if [[ ! -f "$ENTRY" ]]; then
  log "core is not built: $ENTRY is missing — run 'make build' in $REPO_ROOT"
  exit 1
fi

mkdir -p "$DATA_DIR" "$LOGS_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

cd "$REPO_ROOT"
LVF_PORT="$PORT" nohup "$NODE_BIN" "$ENTRY" >>"$LOG_FILE" 2>&1 &
core_pid=$!
printf '%s\n' "$core_pid" >"$PID_FILE"
log "started core (pid $core_pid), log: $LOG_FILE"

deadline=$((SECONDS + 30))
while ((SECONDS < deadline)); do
  if healthy; then
    log "core is healthy on $BASE_URL"
    exit 0
  fi
  if ! kill -0 "$core_pid" 2>/dev/null; then
    log "core exited during startup — see $LOG_FILE"
    exit 1
  fi
  sleep 0.4
done

log "core did not become healthy within 30s — see $LOG_FILE"
exit 1
