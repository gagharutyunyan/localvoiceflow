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
