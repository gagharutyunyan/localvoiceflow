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

# Two parallel starts (this script, make start; launchd spawns node directly and
# is covered only by the health check and the port bind) can each pass the health
# check above before either has bound the port. Only the holder of this mkdir
# lock may fork node. Shared with start.sh — same directory, same protocol — and
# duplicated here because this file must run without _lib.sh. Keyed by port:
# starts for different LVF_PORT values do not compete for anything.
LOCK_DIR="$DATA_DIR/core.start.$PORT.lock"

lock_owner() {
  # stderr silenced before the input redirect: with `<file 2>...` the shell
  # reports a missing file before the redirect takes effect.
  tr -cd '0-9' 2>/dev/null <"$LOCK_DIR/pid" || true
}

lock_stale() {
  # Stale: older than any legitimate startup (a holder waits at most ~30s for
  # health), or the recorded owner is gone and the lock is old enough that the
  # owner cannot still be between mkdir and writing its pid.
  local owner now mtime age
  now="$(date +%s)"
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || printf '%s' "$now")"
  age=$((now - mtime))
  ((age > 120)) && return 0
  owner="$(lock_owner)"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  ((age > 30))
}

release_lock() {
  # Only the recorded owner may remove the lock: after a steal the directory
  # belongs to the stealer, and a path-based rm would destroy their fresh lock.
  if [[ "$(lock_owner)" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
  return 0
}

acquire_lock() {
  local deadline=$((SECONDS + 40))
  while ((SECONDS < deadline)); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" >"$LOCK_DIR/pid"
      trap 'release_lock' EXIT
      return 0
    fi
    if lock_stale; then
      # Steal via atomic rename: a second stealer must never be able to delete
      # the fresh lock the first stealer has just re-created.
      if mv "$LOCK_DIR" "$LOCK_DIR.stale.$$" 2>/dev/null; then
        rm -rf "$LOCK_DIR.stale.$$"
      fi
      continue
    fi
    sleep 0.5
  done
  return 1
}

if ! acquire_lock; then
  if healthy; then
    log "core already listening on $PORT (a parallel start won the race)"
    exit 0
  fi
  log "another core start holds $LOCK_DIR and did not finish — retry, or remove that directory"
  exit 1
fi

# The lock was busy while we waited: whoever held it may have started core.
if healthy; then
  log "core already listening on $PORT"
  exit 0
fi

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
