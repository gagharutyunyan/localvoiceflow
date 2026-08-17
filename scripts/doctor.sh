#!/usr/bin/env bash
#
# One screen that answers "why is dictation not working?".
#
# Permission state is never guessed: only the macOS agent can read TCC, so this
# script asks core (which the agent reports to). When core is down it says the
# state is unknown rather than inventing one.
#
# Exit code: 0 when there are no [FAIL] lines.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: scripts/doctor.sh

Checks the machine, the permissions, core, the STT worker and both LLM CLIs.
Exits 0 when nothing is broken, 1 when at least one check failed.
Honours LVF_PORT (currently $LVF_PORT) and NO_COLOR.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

step "System"

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
if lvf_version_ge "$MACOS_VERSION" "$LVF_MIN_MACOS"; then
  ok "macOS $MACOS_VERSION"
else
  fail "macOS $MACOS_VERSION (need $LVF_MIN_MACOS+)"
  hint "Update macOS: System Settings → General → Software Update"
fi

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  ok "Apple Silicon ($(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo arm64))"
else
  fail "Apple Silicon required — found $(uname -s)/$(uname -m)"
  hint "MLX needs Apple Silicon. This machine cannot run the local STT worker."
fi

if XCODE_DEV_DIR="$(xcode-select -p 2>/dev/null)" && [[ -d "$XCODE_DEV_DIR" ]]; then
  ok "Xcode Command Line Tools ($XCODE_DEV_DIR)"
else
  fail "Xcode Command Line Tools missing"
  hint "Run: xcode-select --install"
fi

# ---------------------------------------------------------------------------
# Core (fetched once, reused by the permission and STT sections)
# ---------------------------------------------------------------------------

CORE_UP=0
DIAGNOSTICS=""
STATUS=""

if lvf_core_reachable 3; then
  CORE_UP=1
  DIAGNOSTICS="$(lvf_api_get /api/diagnostics 10 || true)"
  STATUS="$(lvf_api_get /api/status 5 || true)"
fi

diag_get() {
  [[ -n "$DIAGNOSTICS" ]] || return 1
  printf '%s' "$DIAGNOSTICS" | lvf_json_get "$@" 2>/dev/null
}

status_get() {
  [[ -n "$STATUS" ]] || return 1
  printf '%s' "$STATUS" | lvf_json_get "$@" 2>/dev/null
}

# The diagnostics payload is not pinned by a Zod schema, so look in the obvious
# places first and fall back to a key search before giving up.
lookup() {
  local key="$1"
  shift
  local value=""
  value="$(diag_get "$@" || true)"
  if [[ -z "$value" ]]; then
    value="$(status_get "$@" || true)"
  fi
  if [[ -z "$value" && -n "$DIAGNOSTICS" ]]; then
    value="$(printf '%s' "$DIAGNOSTICS" | lvf_json_find "$key" 2>/dev/null || true)"
  fi
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

step "Permissions"

permission_line() {
  local label="$1" key="$2" pane="$3" state
  state="$(lookup "$key" "permissions.$key" "agent.permissions.$key" "macos.permissions.$key" "tcc.$key")"

  case "$state" in
    granted)
      ok "$label permission: granted"
      ;;
    denied)
      warn "$label permission: denied"
      hint "Open System Settings → Privacy & Security → $pane, then enable LocalVoiceFlow"
      ;;
    not-determined | "not determined")
      warn "$label permission: not requested yet"
      hint "Start the agent and trigger one dictation; macOS asks the first time"
      ;;
    unknown | "")
      warn "$label permission: not reported yet — only the agent can read TCC"
      hint "Launch the menu-bar app: open \"$LVF_APP_BUNDLE\"   (then re-run make doctor)"
      ;;
    *)
      warn "$label permission: $state"
      hint "Open System Settings → Privacy & Security → $pane"
      ;;
  esac
}

if ((CORE_UP == 0)); then
  warn "Microphone / Accessibility / Input Monitoring: unknown — core is not running"
  hint "Only the macOS agent can read TCC. Start it with: make start   (then re-run make doctor)"
elif [[ -z "$DIAGNOSTICS" ]]; then
  warn "Microphone / Accessibility / Input Monitoring: unknown — /api/diagnostics did not answer"
  hint "The bearer token may be missing or stale: check $LVF_TOKEN_FILE, then: make restart"
else
  AGENT_CONNECTED="$(lookup agentConnected "permissions.agentConnected" "agent.connected" "agentConnected")"
  if [[ "$AGENT_CONNECTED" == "false" ]]; then
    warn "the menu-bar agent has never reported in — permission state below may be stale"
    hint "Launch it: open \"$LVF_APP_BUNDLE\""
  fi
  permission_line "Microphone" microphone "Microphone"
  permission_line "Accessibility" accessibility "Accessibility"
  permission_line "Input Monitoring" inputMonitoring "Input Monitoring"
fi

# ---------------------------------------------------------------------------
# Core / STT
# ---------------------------------------------------------------------------

step "Core"

if ((CORE_UP == 1)); then
  # No deep-key fallback here: /api/diagnostics also reports the macOS version.
  CORE_VERSION="$(diag_get version app.version core.version || status_get version || true)"
  ok "Core reachable at $LVF_BASE_URL${CORE_VERSION:+ (v$CORE_VERSION)}"

  STT_READY="$(lookup ready "stt.ready" "sttWorker.ready" "stt.worker.ready")"
  STT_STATE="$(lookup state "stt.state" "sttWorker.state")"
  STT_MODEL="$(lookup model "stt.model" "sttWorker.model" "stt.loadedModel")"
  STT_DEVICE="$(lookup device "stt.device" "sttWorker.device")"
  STT_ERROR="$(lookup error "stt.error" "sttWorker.error")"

  if [[ "$STT_READY" == "true" ]]; then
    ok "STT worker ready${STT_STATE:+ (state: $STT_STATE)}"
  else
    fail "STT worker not ready${STT_STATE:+ (state: $STT_STATE)}${STT_ERROR:+ — $STT_ERROR}"
    hint "Check the venv: $LVF_VENV_DIR/bin/python -c 'import mlx_whisper'"
    hint "Then read the log: tail -n 50 \"$LVF_LOGS_DIR/core.log\""
  fi

  if [[ -n "$STT_MODEL" && "$STT_READY" == "true" ]]; then
    ok "MLX model loaded: $STT_MODEL${STT_DEVICE:+ on $STT_DEVICE}"
  else
    fail "MLX model not loaded${STT_MODEL:+ (configured: $STT_MODEL)}"
    hint "Download it once (~1.6 GB):"
    hint "$LVF_VENV_DIR/bin/python -c \"from huggingface_hub import snapshot_download; snapshot_download('$LVF_STT_MODEL')\""
  fi
else
  fail "Core not reachable at $LVF_BASE_URL"
  hint "Start it: make start   (or: make install to run it as a LaunchAgent)"
  fail "STT worker: unknown — core is down"
  hint "Nothing to do until core is up"
  fail "MLX model: unknown — core is down"
  hint "Nothing to do until core is up"
fi

# ---------------------------------------------------------------------------
# Claude CLI
# ---------------------------------------------------------------------------

step "Claude CLI"

if CLAUDE_BIN="$(lvf_claude 2>/dev/null)"; then
  CLAUDE_VERSION="$("$CLAUDE_BIN" --version 2>/dev/null | head -n 1 | awk '{print $1}' || true)"
  ok "claude ${CLAUDE_VERSION:-unknown} ($CLAUDE_BIN)"

  CLAUDE_AUTH="$(lvf_timeout 25 "$CLAUDE_BIN" auth status 2>/dev/null || true)"
  CLAUDE_LOGGED_IN="$(printf '%s' "$CLAUDE_AUTH" | lvf_json_get loggedIn 2>/dev/null || true)"
  CLAUDE_METHOD="$(printf '%s' "$CLAUDE_AUTH" | lvf_json_get authMethod 2>/dev/null || true)"
  CLAUDE_PLAN="$(printf '%s' "$CLAUDE_AUTH" | lvf_json_get subscriptionType 2>/dev/null || true)"

  if [[ "$CLAUDE_LOGGED_IN" == "true" ]]; then
    ok "authenticated${CLAUDE_METHOD:+ via $CLAUDE_METHOD}${CLAUDE_PLAN:+, plan: $CLAUDE_PLAN}"
  elif printf '%s' "$CLAUDE_AUTH" | grep -qiE 'logged in|authenticated|claude\.ai'; then
    ok "authenticated (per 'claude auth status')"
  else
    fail "claude is not authenticated"
    hint "Run: claude   → then /login, and sign in with your subscription"
  fi
else
  fail "claude CLI not found"
  hint "Run: npm install -g @anthropic-ai/claude-code"
fi

for key_name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; do
  if [[ -n "${!key_name:-}" ]]; then
    warn "$key_name is set and will be ignored in subscription-only mode"
    hint "Nothing to fix if that is intended; core never forwards it to the CLI"
  fi
done

# ---------------------------------------------------------------------------
# Codex CLI
# ---------------------------------------------------------------------------

step "Codex CLI"

if CODEX_BIN="$(lvf_codex 2>/dev/null)"; then
  CODEX_VERSION="$("$CODEX_BIN" --version 2>/dev/null | head -n 1 | awk '{print $NF}' || true)"
  ok "codex ${CODEX_VERSION:-unknown} ($CODEX_BIN)"

  CODEX_LOGIN="$(lvf_timeout 25 "$CODEX_BIN" login status 2>&1 || true)"
  if printf '%s' "$CODEX_LOGIN" | grep -qiE 'logged in'; then
    ok "$(printf '%s' "$CODEX_LOGIN" | head -n 1 || true)"
  else
    fail "codex is not logged in"
    hint "Run: codex login"
  fi
else
  fail "codex CLI not found"
  hint "Run: brew install codex   (only needed for the OpenAI provider)"
fi

for key_name in OPENAI_API_KEY CODEX_API_KEY; do
  if [[ -n "${!key_name:-}" ]]; then
    warn "$key_name is set and will be ignored in subscription-only mode"
    hint "Nothing to fix if that is intended; core never forwards it to the CLI"
  fi
done

# ---------------------------------------------------------------------------
# Storage and port
# ---------------------------------------------------------------------------

step "Storage"

lvf_ensure_dirs

SQLITE_PROBE="$LVF_DATA_DIR/.doctor-sqlite-probe"
rm -f "$SQLITE_PROBE"

if NODE_BIN="$(lvf_node 2>/dev/null)"; then
  SQLITE_SCRIPT='
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO probe (v) VALUES (?)").run("ok");
    const row = db.prepare("SELECT v FROM probe LIMIT 1").get();
    db.close();
    if (row.v !== "ok") process.exitCode = 1;
  '
  if "$NODE_BIN" -e "$SQLITE_SCRIPT" "$SQLITE_PROBE" >/dev/null 2>&1 ||
    "$NODE_BIN" --experimental-sqlite -e "$SQLITE_SCRIPT" "$SQLITE_PROBE" >/dev/null 2>&1; then
    ok "SQLite writable ($LVF_DATA_DIR)"
  else
    fail "SQLite could not create a database in $LVF_DATA_DIR"
    hint "Check permissions: ls -ld \"$LVF_DATA_DIR\"  (node:sqlite needs Node 22.5+)"
  fi
  rm -f "$SQLITE_PROBE"
else
  fail "node not found — cannot verify SQLite"
  hint "Run: brew install node"
fi

PORT_PID="$(lvf_port_pid "$LVF_PORT")"
if [[ -z "$PORT_PID" ]]; then
  ok "Loopback port $LVF_PORT available"
elif ((CORE_UP == 1)); then
  ok "Loopback port $LVF_PORT in use by core (pid $PORT_PID) — expected"
else
  fail "Loopback port $LVF_PORT is held by pid $PORT_PID, which is not core"
  note "$(lvf_process_command "$PORT_PID")"
  hint "Free it, or run with another port: LVF_PORT=43118 make start"
fi

# ---------------------------------------------------------------------------

lvf_summary

if ((LVF_FAIL_COUNT > 0)); then
  exit 1
fi
exit 0
