#!/usr/bin/env bash
#
# Stops core and the menu-bar agent: SIGTERM first, SIGKILL after a grace period.
# Also boots the LaunchAgent out of launchd, otherwise KeepAlive would restart core
# a second after we killed it.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

QUIET=0
GRACE_SECONDS=5

usage() {
  cat <<EOF
Usage: scripts/stop.sh [options]

  --quiet        Only report problems.
  --grace <sec>  Seconds to wait after SIGTERM before SIGKILL (default 5).
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --quiet) QUIET=1 ;;
    --grace)
      shift
      GRACE_SECONDS="${1:-5}"
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

say_ok() {
  ((QUIET == 1)) || ok "$@"
}

((QUIET == 1)) || step "Stopping LocalVoiceFlow"

UID_NUM="$(id -u)"

# --- launchd ---------------------------------------------------------------
if lvf_launchagent_loaded; then
  if launchctl bootout "gui/$UID_NUM/$LVF_AGENT_LABEL" >/dev/null 2>&1; then
    say_ok "LaunchAgent booted out (gui/$UID_NUM/$LVF_AGENT_LABEL)"
  else
    warn "launchctl bootout reported an error for $LVF_AGENT_LABEL"
    hint "Inspect it with: launchctl print gui/$UID_NUM/$LVF_AGENT_LABEL"
  fi
else
  say_ok "LaunchAgent not loaded"
fi

# --- pidfile ---------------------------------------------------------------
if [[ -f "$LVF_PID_FILE" ]]; then
  CORE_PID="$(tr -cd '0-9' <"$LVF_PID_FILE")"
  if [[ -n "$CORE_PID" ]] && kill -0 "$CORE_PID" 2>/dev/null; then
    lvf_kill_gracefully "$CORE_PID" "$GRACE_SECONDS"
    say_ok "core stopped (pid $CORE_PID)"
  else
    say_ok "stale pidfile removed"
  fi
  rm -f "$LVF_PID_FILE"
else
  say_ok "no pidfile"
fi

# --- anything else still holding the port ----------------------------------
# Only ever kill a process whose command line is unmistakably this project's core;
# an unrelated process on the same port is reported, never killed.
PORT_PID="$(lvf_port_pid "$LVF_PORT")"
if [[ -n "$PORT_PID" ]]; then
  PORT_CMD="$(lvf_process_command "$PORT_PID")"
  case "$PORT_CMD" in
    *"$LVF_REPO_ROOT/apps/core"* | *"apps/core/dist/main.js"* | *"apps/core/src/main.ts"*)
      lvf_kill_gracefully "$PORT_PID" "$GRACE_SECONDS"
      say_ok "core on port $LVF_PORT stopped (pid $PORT_PID)"
      ;;
    *)
      warn "port $LVF_PORT is held by an unrelated process (pid $PORT_PID) — left alone"
      note "${PORT_CMD:-<command unavailable>}"
      hint "Identify it with: lsof -nP -iTCP:$LVF_PORT -sTCP:LISTEN"
      ;;
  esac
else
  say_ok "port $LVF_PORT is free"
fi

# --- menu-bar agent --------------------------------------------------------
AGENT_PATTERN="$LVF_APP_BUNDLE/Contents/MacOS/"
AGENT_PIDS="$(pgrep -f "$AGENT_PATTERN" 2>/dev/null || true)"
if [[ -n "$AGENT_PIDS" ]]; then
  while IFS= read -r agent_pid; do
    [[ -n "$agent_pid" ]] || continue
    lvf_kill_gracefully "$agent_pid" "$GRACE_SECONDS"
    say_ok "agent stopped (pid $agent_pid)"
  done <<<"$AGENT_PIDS"
else
  say_ok "agent not running"
fi

((QUIET == 1)) || lvf_summary
exit 0
