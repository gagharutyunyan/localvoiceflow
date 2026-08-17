#!/usr/bin/env bash
#
# Checks the toolchain this project needs, then installs the project's own
# dependencies (pnpm workspace + the STT worker's Python venv).
#
# It never installs system tools, never edits your shell profile, never touches
# the Claude/Codex configuration and never asks for an API key. When something is
# missing it prints the exact command you should run yourself.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

CHECK_ONLY=0

usage() {
  cat <<EOF
Usage: scripts/bootstrap.sh [options]

  --check-only   Only report on the toolchain; install nothing.
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
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

step "Environment"

# --- hardware / OS ---------------------------------------------------------
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  ok "Apple Silicon ($(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo arm64))"
else
  fail "Apple Silicon required — found $(uname -s)/$(uname -m)"
  hint "LocalVoiceFlow uses MLX, which runs on Apple Silicon only. There is no fallback."
fi

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if lvf_version_ge "$MACOS_VERSION" "$LVF_MIN_MACOS"; then
  ok "macOS $MACOS_VERSION"
else
  fail "macOS $MACOS_VERSION is older than the required $LVF_MIN_MACOS"
  hint "Update macOS: System Settings → General → Software Update"
fi

# --- Xcode command line tools ---------------------------------------------
if XCODE_DEV_DIR="$(xcode-select -p 2>/dev/null)" && [[ -d "$XCODE_DEV_DIR" ]]; then
  ok "Xcode Command Line Tools ($XCODE_DEV_DIR)"
else
  fail "Xcode Command Line Tools not found"
  hint "Run: xcode-select --install"
fi

# --- node ------------------------------------------------------------------
if NODE_BIN="$(lvf_node 2>/dev/null)"; then
  NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null | tr -d 'v')"
  if lvf_version_ge "$NODE_VERSION" "$LVF_MIN_NODE"; then
    ok "Node v$NODE_VERSION ($NODE_BIN)"
  else
    fail "Node v$NODE_VERSION is older than the required v$LVF_MIN_NODE"
    hint "Run: brew install node   (or: fnm install --lts && fnm default lts-latest)"
  fi
else
  NODE_BIN=""
  fail "Node not found"
  hint "Run: brew install node"
fi

# --- pnpm ------------------------------------------------------------------
if PNPM_BIN="$(lvf_pnpm 2>/dev/null)"; then
  ok "pnpm $("$PNPM_BIN" --version 2>/dev/null) ($PNPM_BIN)"
else
  PNPM_BIN=""
  fail "pnpm not found"
  hint "Run: corepack enable pnpm   (or: npm install -g pnpm@9.15.9)"
fi

# --- python ----------------------------------------------------------------
if PYTHON_BIN="$(lvf_python 2>/dev/null)"; then
  ok "Python $("$PYTHON_BIN" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') ($PYTHON_BIN)"
else
  PYTHON_BIN=""
  fail "Python $LVF_MIN_PYTHON+ not found"
  hint "Run: brew install python@3.13"
fi

# --- uv (optional) ---------------------------------------------------------
if UV_BIN="$(lvf_which uv 2>/dev/null)"; then
  ok "uv $("$UV_BIN" --version 2>/dev/null | awk '{print $2}') ($UV_BIN) — will be used for the venv"
else
  UV_BIN=""
  printf '%s[----]%s uv not installed (OPTIONAL — python -m venv is used instead)\n' \
    "$LVF_C_DIM" "$LVF_C_RESET"
  note "Nothing to do. Install it only if you want it: brew install uv"
fi

# --- swift -----------------------------------------------------------------
if SWIFT_BIN="$(lvf_swift 2>/dev/null)"; then
  SWIFT_VERSION="$("$SWIFT_BIN" --version 2>&1 | sed -n 's/.*Apple Swift version \([0-9.]*\).*/\1/p' | head -n 1 || true)"
  ok "Swift ${SWIFT_VERSION:-unknown} ($SWIFT_BIN)"
else
  fail "Swift not found"
  hint "Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
fi

# --- LLM CLIs --------------------------------------------------------------
if CLAUDE_BIN="$(lvf_claude 2>/dev/null)"; then
  ok "claude $("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}') ($CLAUDE_BIN)"
else
  fail "claude CLI not found"
  hint "Run: npm install -g @anthropic-ai/claude-code   (then: claude  → log in with your subscription)"
fi

if CODEX_BIN="$(lvf_codex 2>/dev/null)"; then
  ok "codex $("$CODEX_BIN" --version 2>/dev/null | awk '{print $NF}') ($CODEX_BIN)"
else
  warn "codex CLI not found (only needed for the OpenAI provider)"
  hint "Run: brew install codex   (then: codex login)"
fi

# --- ffmpeg (optional but used by the fixtures) ----------------------------
if FFMPEG_BIN="$(lvf_which ffmpeg 2>/dev/null)"; then
  ok "ffmpeg ($FFMPEG_BIN)"
else
  warn "ffmpeg not found — audio fixtures cannot be re-encoded"
  hint "Run: brew install ffmpeg"
fi

if ((LVF_FAIL_COUNT > 0)); then
  printf '\n'
  die "$LVF_FAIL_COUNT required tool(s) missing — run the commands above, then re-run scripts/bootstrap.sh"
fi

if ((CHECK_ONLY == 1)); then
  lvf_summary
  printf '%sChecks only; nothing was installed.%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
  exit 0
fi

# ---------------------------------------------------------------------------
# Project dependencies
# ---------------------------------------------------------------------------

step "Installing workspace dependencies (pnpm)"
(cd "$LVF_REPO_ROOT" && "$PNPM_BIN" install)
ok "pnpm install finished"

step "Building @lvf/shared"
(cd "$LVF_REPO_ROOT" && "$PNPM_BIN" --filter @lvf/shared build)
ok "@lvf/shared built"

step "Python environment for the STT worker"

mkdir -p "$LVF_STT_DIR"

REQUIREMENTS="$LVF_STT_DIR/requirements.txt"
DEFAULT_PACKAGES=("mlx-whisper>=0.4.3" "numpy>=1.26")

if [[ -x "$LVF_VENV_DIR/bin/python" ]]; then
  ok "venv already present ($LVF_VENV_DIR)"
else
  if [[ -n "$UV_BIN" ]]; then
    "$UV_BIN" venv --python "$PYTHON_BIN" "$LVF_VENV_DIR"
    ok "venv created with uv"
  else
    "$PYTHON_BIN" -m venv "$LVF_VENV_DIR"
    ok "venv created with $PYTHON_BIN -m venv"
  fi
fi

VENV_PYTHON="$LVF_VENV_DIR/bin/python"
[[ -x "$VENV_PYTHON" ]] || die "venv is broken: $VENV_PYTHON is missing. Remove $LVF_VENV_DIR and re-run."

if [[ -n "$UV_BIN" ]]; then
  if [[ -f "$REQUIREMENTS" ]]; then
    "$UV_BIN" pip install --python "$VENV_PYTHON" -r "$REQUIREMENTS"
  else
    warn "$REQUIREMENTS not found — installing the known-good default set"
    "$UV_BIN" pip install --python "$VENV_PYTHON" "${DEFAULT_PACKAGES[@]}"
  fi
else
  "$VENV_PYTHON" -m pip install --upgrade pip >/dev/null
  if [[ -f "$REQUIREMENTS" ]]; then
    "$VENV_PYTHON" -m pip install -r "$REQUIREMENTS"
  else
    warn "$REQUIREMENTS not found — installing the known-good default set"
    "$VENV_PYTHON" -m pip install "${DEFAULT_PACKAGES[@]}"
  fi
fi

if "$VENV_PYTHON" -c 'import mlx_whisper, mlx.core as mx; print(mx.default_device())' >/dev/null 2>&1; then
  ok "mlx-whisper imports, MLX device: $("$VENV_PYTHON" -c 'import mlx.core as mx; print(mx.default_device())' 2>/dev/null)"
else
  fail "mlx-whisper does not import inside the venv"
  hint "Run: $VENV_PYTHON -m pip install --force-reinstall mlx-whisper"
fi

# ---------------------------------------------------------------------------
# STT model — never downloaded implicitly, it is 1.6 GB.
# ---------------------------------------------------------------------------

step "Speech model"

HF_CACHE="${HUGGINGFACE_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
MODEL_DIR="$HF_CACHE/models--${LVF_STT_MODEL//\//--}"

if [[ -d "$MODEL_DIR" ]]; then
  ok "$LVF_STT_MODEL already in the Hugging Face cache"
  note "$MODEL_DIR"
else
  warn "$LVF_STT_MODEL is not downloaded yet (~1.6 GB)"
  hint "Run this once, when you are ready to spend the bandwidth:"
  printf '\n  %s%s -c "from huggingface_hub import snapshot_download; snapshot_download(\x27%s\x27)"%s\n\n' \
    "$LVF_C_BOLD" "$VENV_PYTHON" "$LVF_STT_MODEL" "$LVF_C_RESET"
fi

step "Next steps"
printf '  make build     # build core, web, the Swift agent and the .app bundle\n'
printf '  make install   # install the LaunchAgent and open the dashboard\n'
printf '  make doctor    # verify permissions, CLIs and the STT worker\n'

lvf_summary
exit 0
