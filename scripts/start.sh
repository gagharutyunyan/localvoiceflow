#!/usr/bin/env bash
#
# Starts core (if nothing is listening yet) and the menu-bar agent, then prints a
# dashboard URL that already carries the session token.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

START_AGENT=1
OPEN_BROWSER=0
WAIT_SECONDS=25

usage() {
  cat <<EOF
Usage: scripts/start.sh [options]

  --no-agent     Do not launch the menu-bar app.
  --open         Also open the dashboard in the default browser.
  --wait <sec>   How long to wait for core to become healthy (default 25).
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --no-agent) START_AGENT=0 ;;
    --open) OPEN_BROWSER=1 ;;
    --wait)
      shift
      WAIT_SECONDS="${1:-25}"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

lvf_require_macos_arm64
lvf_ensure_dirs

# Two parallel starts (make start, start-core.sh, the app bundle) can each pass
# the health check below before either has bound the port. Only the holder of
# this mkdir lock may fork node; everyone else waits and re-checks. Shared with
# start-core.sh — same directory, same protocol. Keyed by port: starts for
# different LVF_PORT values do not compete for anything.
START_LOCK_DIR="$LVF_DATA_DIR/core.start.$LVF_PORT.lock"

start_lock_owner() {
  # stderr silenced before the input redirect: with `<file 2>...` the shell
  # reports a missing file before the redirect takes effect.
  tr -cd '0-9' 2>/dev/null <"$START_LOCK_DIR/pid" || true
}

start_lock_stale() {
  # Stale: older than any legitimate startup (a holder waits at most ~30s for
  # health), or the recorded owner is gone and the lock is old enough that the
  # owner cannot still be between mkdir and writing its pid.
  local owner now mtime age
  now="$(date +%s)"
  mtime="$(stat -f %m "$START_LOCK_DIR" 2>/dev/null || printf '%s' "$now")"
  age=$((now - mtime))
  ((age > 120)) && return 0
  owner="$(start_lock_owner)"
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    return 1
  fi
  ((age > 30))
}

release_start_lock() {
  # Only the recorded owner may remove the lock: after a steal the directory
  # belongs to the stealer, and a path-based rm would destroy their fresh lock.
  if [[ "$(start_lock_owner)" == "$$" ]]; then
    rm -rf "$START_LOCK_DIR"
  fi
  return 0
}

acquire_start_lock() {
  local deadline=$((SECONDS + 40))
  while ((SECONDS < deadline)); do
    if mkdir "$START_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" >"$START_LOCK_DIR/pid"
      trap 'release_start_lock' EXIT
      return 0
    fi
    if start_lock_stale; then
      # Steal via atomic rename: a second stealer must never be able to delete
      # the fresh lock the first stealer has just re-created.
      if mv "$START_LOCK_DIR" "$START_LOCK_DIR.stale.$$" 2>/dev/null; then
        rm -rf "$START_LOCK_DIR.stale.$$"
      fi
      continue
    fi
    sleep 0.5
  done
  return 1
}

step "Core"

if lvf_core_reachable 2; then
  ok "already listening on $LVF_BASE_URL"
elif lvf_launchagent_loaded; then
  # launchd owns the process; starting a second copy would just lose the port race.
  launchctl kickstart -k "gui/$(id -u)/$LVF_AGENT_LABEL" >/dev/null 2>&1 ||
    die "launchctl kickstart failed for $LVF_AGENT_LABEL"
  if lvf_wait_for_core "$WAIT_SECONDS"; then
    ok "core started by launchd"
  else
    fail "core did not become healthy within ${WAIT_SECONDS}s"
    hint "Read the log: tail -n 50 \"$LVF_LOGS_DIR/core.err.log\""
    exit 1
  fi
else
  NODE_BIN="$(lvf_node)" || die "node not found. Run scripts/bootstrap.sh."
  [[ -f "$LVF_CORE_ENTRY" ]] || die "core is not built: $LVF_CORE_ENTRY — run 'make build'"

  if ! acquire_start_lock; then
    # Could not get the lock: a parallel start is still working, or a stuck
    # lock survived even the staleness rules. Health decides which it was.
    if lvf_core_reachable 2; then
      ok "already listening on $LVF_BASE_URL (a parallel start won the race)"
    else
      fail "another start holds $START_LOCK_DIR and did not finish"
      hint "Retry in a few seconds; if it persists, remove that directory."
      exit 1
    fi
  elif lvf_core_reachable 2; then
    # The lock was busy while we waited: whoever held it started core already.
    ok "already listening on $LVF_BASE_URL"
  else
    if PORT_PID="$(lvf_port_pid "$LVF_PORT")" && [[ -n "$PORT_PID" ]]; then
      fail "port $LVF_PORT is already taken by pid $PORT_PID, but it does not answer /api/health"
      note "$(lvf_process_command "$PORT_PID")"
      hint "Free it with: scripts/stop.sh   (or set LVF_PORT to another port)"
      exit 1
    fi

    (
      cd "$LVF_REPO_ROOT"
      LVF_PORT="$LVF_PORT" nohup "$NODE_BIN" "$LVF_CORE_ENTRY" >>"$LVF_CORE_LOG" 2>&1 &
      printf '%s\n' "$!" >"$LVF_PID_FILE"
    )
    CORE_PID="$(tr -cd '0-9' <"$LVF_PID_FILE")"
    ok "core started (pid $CORE_PID), log: $LVF_CORE_LOG"

    if lvf_wait_for_core "$WAIT_SECONDS"; then
      ok "healthy on $LVF_BASE_URL"
    else
      fail "core did not become healthy within ${WAIT_SECONDS}s"
      hint "Read the log: tail -n 50 \"$LVF_CORE_LOG\""
      exit 1
    fi
  fi
fi

step "Agent"

if ((START_AGENT == 1)); then
  if [[ -d "$LVF_APP_BUNDLE" ]]; then
    if pgrep -f "$LVF_APP_BUNDLE/Contents/MacOS/" >/dev/null 2>&1; then
      ok "menu-bar agent already running"
    elif open "$LVF_APP_BUNDLE"; then
      ok "menu-bar agent launched"
    else
      fail "could not launch $LVF_APP_BUNDLE"
      hint "Run: make build && make install"
    fi
  else
    warn "$LVF_APP_BUNDLE not installed"
    hint "Run: make install"
  fi
else
  note "agent not started (--no-agent)"
fi

DASHBOARD_URL="$(lvf_dashboard_url)"

step "Dashboard"
printf '  %s%s%s\n' "$LVF_C_BOLD" "$DASHBOARD_URL" "$LVF_C_RESET"
case "$DASHBOARD_URL" in
  *token=*) note "The token in that URL sets an HttpOnly session cookie; the browser never sees the token file." ;;
  *) note "No token file yet at $LVF_TOKEN_FILE — core writes it on first start." ;;
esac

if ((OPEN_BROWSER == 1)); then
  open "$DASHBOARD_URL" >/dev/null 2>&1 || warn "could not open the browser; copy the URL above"
fi

lvf_summary
exit 0
