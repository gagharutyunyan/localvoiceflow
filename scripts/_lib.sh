#!/usr/bin/env bash
# Shared helpers for the LocalVoiceFlow scripts. This file is sourced, not executed.

if [[ -n "${LVF_LIB_SOURCED:-}" ]]; then
  return 0
fi
LVF_LIB_SOURCED=1

# ---------------------------------------------------------------------------
# Locations. Nothing the app writes ever lives inside the repository.
# ---------------------------------------------------------------------------

LVF_APP_NAME="LocalVoiceFlow"
LVF_AGENT_LABEL="com.localvoiceflow.agent"
LVF_DATA_DIR="$HOME/Library/Application Support/$LVF_APP_NAME"
LVF_AUDIO_DIR="$LVF_DATA_DIR/audio"
LVF_LOGS_DIR="$HOME/Library/Logs/$LVF_APP_NAME"
LVF_APP_BUNDLE="$HOME/Applications/$LVF_APP_NAME.app"
LVF_LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LVF_PLIST="$LVF_LAUNCH_AGENTS_DIR/$LVF_AGENT_LABEL.plist"
LVF_TOKEN_FILE="$LVF_DATA_DIR/token"
LVF_PID_FILE="$LVF_DATA_DIR/core.pid"
LVF_CORE_LOG="$LVF_LOGS_DIR/core.log"
LVF_HOST="127.0.0.1"
LVF_PORT="${LVF_PORT:-43117}"
LVF_BASE_URL="http://$LVF_HOST:$LVF_PORT"
LVF_AGENT_BINARY_NAME="LocalVoiceFlowAgent"

LVF_SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LVF_REPO_ROOT="${LVF_SCRIPT_DIR%/*}"

LVF_CORE_ENTRY="$LVF_REPO_ROOT/apps/core/dist/main.js"
LVF_BENCH_ENTRY="$LVF_REPO_ROOT/apps/core/dist/benchmark.js"
LVF_SMOKE_ENTRY="$LVF_REPO_ROOT/apps/core/dist/smoke.js"
LVF_STT_DIR="$LVF_REPO_ROOT/services/stt-worker"
LVF_VENV_DIR="$LVF_STT_DIR/.venv"
LVF_MAC_AGENT_DIR="$LVF_REPO_ROOT/apps/mac-agent"

LVF_STT_MODEL="mlx-community/whisper-large-v3-turbo"
LVF_MIN_NODE="22.5.0"
LVF_MIN_PYTHON="3.11"
LVF_MIN_MACOS="14.0"

# ---------------------------------------------------------------------------
# Output. Colour only when stdout is a real terminal.
# ---------------------------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != "dumb" ]]; then
  LVF_C_RESET=$'\033[0m'
  LVF_C_GREEN=$'\033[32m'
  LVF_C_YELLOW=$'\033[33m'
  LVF_C_RED=$'\033[31m'
  LVF_C_BLUE=$'\033[34m'
  LVF_C_DIM=$'\033[2m'
  LVF_C_BOLD=$'\033[1m'
else
  LVF_C_RESET=""
  LVF_C_GREEN=""
  LVF_C_YELLOW=""
  LVF_C_RED=""
  LVF_C_BLUE=""
  LVF_C_DIM=""
  LVF_C_BOLD=""
fi

LVF_OK_COUNT=0
LVF_WARN_COUNT=0
LVF_FAIL_COUNT=0

ok() {
  LVF_OK_COUNT=$((LVF_OK_COUNT + 1))
  printf '%s[OK]%s   %s\n' "$LVF_C_GREEN" "$LVF_C_RESET" "$*"
}

warn() {
  LVF_WARN_COUNT=$((LVF_WARN_COUNT + 1))
  printf '%s[WARN]%s %s\n' "$LVF_C_YELLOW" "$LVF_C_RESET" "$*"
}

fail() {
  LVF_FAIL_COUNT=$((LVF_FAIL_COUNT + 1))
  printf '%s[FAIL]%s %s\n' "$LVF_C_RED" "$LVF_C_RESET" "$*"
}

# Concrete next action, printed under a WARN or FAIL line.
hint() {
  printf '       %s→ %s%s\n' "$LVF_C_DIM" "$*" "$LVF_C_RESET"
}

note() {
  printf '       %s%s%s\n' "$LVF_C_DIM" "$*" "$LVF_C_RESET"
}

step() {
  printf '\n%s==>%s %s%s%s\n' "$LVF_C_BLUE" "$LVF_C_RESET" "$LVF_C_BOLD" "$*" "$LVF_C_RESET"
}

die() {
  printf '%s[FAIL]%s %s\n' "$LVF_C_RED" "$LVF_C_RESET" "$*" >&2
  exit 1
}

lvf_summary() {
  printf '\n%s%d ok, %d warn, %d fail%s\n' "$LVF_C_DIM" \
    "$LVF_OK_COUNT" "$LVF_WARN_COUNT" "$LVF_FAIL_COUNT" "$LVF_C_RESET"
}

# ---------------------------------------------------------------------------
# Path / tool resolution
# ---------------------------------------------------------------------------

lvf_realpath() {
  local p="$1"
  if [[ -x /bin/realpath ]]; then
    /bin/realpath "$p" 2>/dev/null && return 0
  fi
  local dir base
  dir="$(cd -P -- "$(dirname -- "$p")" 2>/dev/null && pwd -P)" || return 1
  base="$(basename -- "$p")"
  printf '%s/%s\n' "${dir%/}" "$base"
}

# Some launchers hand out per-shell symlink farms (fnm) whose paths die with the
# shell. launchd and .app bundles need a path that still exists tomorrow, so those
# get dereferenced; everything else keeps the stable PATH location it was found at
# (dereferencing e.g. ~/.local/bin/claude would pin a version that self-updates).
lvf_stable_path() {
  local p="$1"
  case "$p" in
    */fnm_multishells/* | */.nvm/alias/* | /tmp/* | /private/tmp/* | /private/var/folders/*)
      lvf_realpath "$p" || printf '%s\n' "$p"
      ;;
    *)
      printf '%s\n' "$p"
      ;;
  esac
}

# Absolute path of an executable, ignoring shell aliases and functions.
lvf_which() {
  local name="$1" found d
  found="$(command -v "$name" 2>/dev/null || true)"
  case "$found" in
    /*)
      lvf_stable_path "$found"
      return 0
      ;;
  esac
  for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    if [[ -x "$d/$name" ]]; then
      lvf_stable_path "$d/$name"
      return 0
    fi
  done
  return 1
}

lvf_have() {
  lvf_which "$1" >/dev/null 2>&1
}

LVF_NODE_CACHED=""
lvf_node() {
  if [[ -n "$LVF_NODE_CACHED" ]]; then
    printf '%s\n' "$LVF_NODE_CACHED"
    return 0
  fi
  local p
  p="$(lvf_which node)" || return 1
  LVF_NODE_CACHED="$p"
  printf '%s\n' "$p"
}

lvf_pnpm() { lvf_which pnpm; }
lvf_claude() { lvf_which claude; }
lvf_codex() { lvf_which codex; }
lvf_swift() { lvf_which swift; }

# Newest interpreter that satisfies LVF_MIN_PYTHON.
lvf_python() {
  local cand p ver
  for cand in python3.14 python3.13 python3.12 python3.11 python3; do
    p="$(lvf_which "$cand" 2>/dev/null || true)"
    [[ -n "$p" ]] || continue
    ver="$("$p" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
    [[ -n "$ver" ]] || continue
    if lvf_version_ge "$ver" "$LVF_MIN_PYTHON"; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

lvf_venv_python() {
  if [[ -x "$LVF_VENV_DIR/bin/python" ]]; then
    printf '%s\n' "$LVF_VENV_DIR/bin/python"
    return 0
  fi
  return 1
}

# lvf_version_ge <have> <want> — dotted numeric compare, tolerant of suffixes.
lvf_version_ge() {
  local have="$1" want="$2" i x y
  local -a a b
  IFS='.' read -r -a a <<<"$have"
  IFS='.' read -r -a b <<<"$want"
  for i in 0 1 2; do
    x="${a[i]:-0}"
    y="${b[i]:-0}"
    x="${x%%[!0-9]*}"
    y="${y%%[!0-9]*}"
    x=$((10#${x:-0}))
    y=$((10#${y:-0}))
    if ((x > y)); then return 0; fi
    if ((x < y)); then return 1; fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# Process / port / HTTP
# ---------------------------------------------------------------------------

# Prints the listening pid, or nothing. Always succeeds: lsof exits 1 when it finds
# nothing, and callers assign this in a bare `x=$(...)` under `set -e`.
lvf_port_pid() {
  local port="${1:-$LVF_PORT}"
  if [[ -x /usr/sbin/lsof ]]; then
    /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
  fi
  return 0
}

lvf_port_in_use() {
  [[ -n "$(lvf_port_pid "${1:-$LVF_PORT}")" ]]
}

lvf_process_command() {
  ps -o command= -p "$1" 2>/dev/null || true
}

lvf_core_reachable() {
  curl -fsS -m "${1:-2}" "$LVF_BASE_URL/api/health" >/dev/null 2>&1
}

lvf_wait_for_core() {
  local deadline=$((SECONDS + ${1:-20}))
  while ((SECONDS < deadline)); do
    if lvf_core_reachable 1; then return 0; fi
    sleep 0.4
  done
  return 1
}

lvf_read_token() {
  [[ -r "$LVF_TOKEN_FILE" ]] || return 1
  local tok
  tok="$(tr -d '\r\n' <"$LVF_TOKEN_FILE")"
  # Anything outside this set is not a token this app produced; refuse to use it
  # rather than feed unexpected bytes into a curl config or a URL.
  # (The length is checked separately: bash 3.2, the only bash on stock macOS,
  # does not honour {n,m} intervals in [[ =~ ]].)
  [[ "$tok" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || return 1
  ((${#tok} >= 16 && ${#tok} <= 512)) || return 1
  printf '%s\n' "$tok"
}

lvf_dashboard_url() {
  local tok
  if tok="$(lvf_read_token)"; then
    printf '%s/session?token=%s\n' "$LVF_BASE_URL" "$tok"
  else
    printf '%s/\n' "$LVF_BASE_URL"
  fi
}

# GET a core endpoint, authenticating with the bearer token when one exists.
# The token goes through a curl config on stdin, never argv, so it does not show
# up in `ps` output for other local processes.
lvf_api_get() {
  local path="$1" timeout="${2:-5}" tok=""
  tok="$(lvf_read_token 2>/dev/null || true)"
  if [[ -n "$tok" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$tok" |
      curl -fsS -m "$timeout" -K - "$LVF_BASE_URL$path" 2>/dev/null
  else
    curl -fsS -m "$timeout" "$LVF_BASE_URL$path" 2>/dev/null
  fi
}

# lvf_timeout <seconds> <cmd...> — macOS ships no timeout(1).
lvf_timeout() {
  local secs="$1"
  shift
  "$@" &
  local pid=$! ticks=0 limit
  limit=$((secs * 10))
  while kill -0 "$pid" 2>/dev/null; do
    if ((ticks >= limit)); then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.5
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
}

# SIGTERM, then SIGKILL once the grace period is over.
lvf_kill_gracefully() {
  local pid="$1" grace="${2:-5}" ticks=0 limit
  limit=$((grace * 10))
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    if ((ticks >= limit)); then
      kill -KILL "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  return 0
}

lvf_launchagent_loaded() {
  launchctl print "gui/$(id -u)/$LVF_AGENT_LABEL" >/dev/null 2>&1
}

lvf_ensure_dirs() {
  mkdir -p "$LVF_DATA_DIR" "$LVF_AUDIO_DIR" "$LVF_LOGS_DIR"
  chmod 700 "$LVF_DATA_DIR" "$LVF_AUDIO_DIR" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# JSON, via node (the one JSON parser this project is guaranteed to have)
# ---------------------------------------------------------------------------

# lvf_json_get <path> [fallback-path...] — JSON document on stdin. Prints the
# first path that resolves to something non-empty; exit 1 when none do.
lvf_json_get() {
  local node_bin
  node_bin="$(lvf_node)" || return 2
  "$node_bin" -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(raw); } catch (err) { process.exitCode = 3; return; }
      const seek = (obj, path) => path.split(".").reduce(
        (acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
      for (const path of process.argv.slice(1)) {
        const value = seek(doc, path);
        if (value !== undefined && value !== null && value !== "") {
          process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
          process.exitCode = 0;
          return;
        }
      }
      process.exitCode = 1;
    });
  ' "$@"
}

# lvf_json_find <key> — breadth-first search for the first scalar under <key>
# anywhere in the document. Used where the exact shape of a payload is not pinned
# down by a schema.
lvf_json_find() {
  local node_bin
  node_bin="$(lvf_node)" || return 2
  "$node_bin" -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(raw); } catch (err) { process.exitCode = 3; return; }
      const wanted = String(process.argv[1]).toLowerCase();
      const queue = [doc];
      while (queue.length > 0) {
        const node = queue.shift();
        if (node === null || typeof node !== "object") continue;
        for (const [key, value] of Object.entries(node)) {
          if (key.toLowerCase() === wanted && value !== null && value !== undefined
              && typeof value !== "object" && value !== "") {
            process.stdout.write(String(value));
            process.exitCode = 0;
            return;
          }
        }
        for (const value of Object.values(node)) {
          if (value !== null && typeof value === "object") queue.push(value);
        }
      }
      process.exitCode = 1;
    });
  ' "$1"
}

lvf_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

lvf_require_macos_arm64() {
  [[ "$(uname -s)" == "Darwin" ]] || die "LocalVoiceFlow is macOS-only (found $(uname -s))."
  [[ "$(uname -m)" == "arm64" ]] || die "LocalVoiceFlow requires Apple Silicon (found $(uname -m))."
}

:
