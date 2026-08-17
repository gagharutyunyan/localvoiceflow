#!/usr/bin/env bash
#
# Builds everything, installs ~/Applications/LocalVoiceFlow.app and registers the
# LaunchAgent that keeps core running. No sudo: everything lives in the user's
# own gui/$UID launchd domain.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

SKIP_SWIFT=0
OPEN_DASHBOARD=1

usage() {
  cat <<EOF
Usage: scripts/install.sh [options]

  --skip-swift   Pass --skip-swift to build.sh (JS/TS only).
  --no-open      Do not open the dashboard or the agent app afterwards.
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-swift) SKIP_SWIFT=1 ;;
    --no-open) OPEN_DASHBOARD=0 ;;
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

[[ "$(id -u)" != "0" ]] || die "Do not run install.sh with sudo — it installs into your own user domain."

# Повторный запуск — это переустановка поверх, а не второй экземпляр: LaunchAgent
# выгружается и загружается заново, .app пересобирается на месте, данные не трогаются.
# Без этой строки непонятно, что происходит при втором `make install`.
step "Режим установки"
if [[ -d "$LVF_APP_BUNDLE" || -f "$LVF_PLIST" ]]; then
  REINSTALL=1
  note "Найдена предыдущая установка — переустанавливаю поверх"
  [[ -d "$LVF_APP_BUNDLE" ]] && ok "заменю приложение: $LVF_APP_BUNDLE"
  [[ -f "$LVF_PLIST" ]] && ok "перезагружу автозапуск: $LVF_PLIST"
  ok "история, словарь и настройки останутся нетронутыми"
else
  REINSTALL=0
  note "Первая установка"
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

if ((SKIP_SWIFT == 1)); then
  "$LVF_BIN_DIR/build.sh" --skip-swift
else
  "$LVF_BIN_DIR/build.sh"
fi

# ---------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------

step "User directories"
lvf_ensure_dirs
ok "data:  $LVF_DATA_DIR"
ok "audio: $LVF_AUDIO_DIR"
ok "logs:  $LVF_LOGS_DIR"

# ---------------------------------------------------------------------------
# Resolve everything to absolute paths — launchd has no interactive PATH
# ---------------------------------------------------------------------------

step "Resolving absolute paths for launchd"

NODE_BIN="$(lvf_node)" || die "node not found. Run scripts/bootstrap.sh."
[[ -f "$LVF_CORE_ENTRY" ]] || die "core is not built: $LVF_CORE_ENTRY"

VENV_PYTHON=""
if VENV_PYTHON="$(lvf_venv_python 2>/dev/null)"; then
  ok "python (venv): $VENV_PYTHON"
else
  VENV_PYTHON=""
  warn "STT venv not found at $LVF_VENV_DIR"
  hint "Run: scripts/bootstrap.sh   (core will start, but transcription will not work)"
fi

ok "node: $NODE_BIN"
ok "core: $LVF_CORE_ENTRY"

# PATH for the launchd job: the directories of the tools core actually spawns,
# plus the system defaults. launchd jobs otherwise get /usr/bin:/bin:/usr/sbin:/sbin.
declare -a PATH_DIRS=()
add_path_dir() {
  local dir="$1" existing
  [[ -n "$dir" && -d "$dir" ]] || return 0
  for existing in ${PATH_DIRS[@]+"${PATH_DIRS[@]}"}; do
    [[ "$existing" == "$dir" ]] && return 0
  done
  PATH_DIRS+=("$dir")
}

add_path_dir "$(dirname "$NODE_BIN")"
for tool in claude codex ffmpeg python3 swift; do
  tool_path="$(lvf_which "$tool" 2>/dev/null || true)"
  [[ -n "$tool_path" ]] && add_path_dir "$(dirname "$tool_path")"
done
[[ -n "$VENV_PYTHON" ]] && add_path_dir "$(dirname "$VENV_PYTHON")"
for dir in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  add_path_dir "$dir"
done

LAUNCHD_PATH="$(
  IFS=:
  printf '%s' "${PATH_DIRS[*]}"
)"
ok "PATH: $LAUNCHD_PATH"

# ---------------------------------------------------------------------------
# Stop whatever is running now, so the LaunchAgent can bind the port
# ---------------------------------------------------------------------------

"$LVF_BIN_DIR/stop.sh" --quiet || true

# ---------------------------------------------------------------------------
# LaunchAgent
# ---------------------------------------------------------------------------

step "Writing $LVF_PLIST"

mkdir -p "$LVF_LAUNCH_AGENTS_DIR"

{
  cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$(lvf_xml_escape "$LVF_AGENT_LABEL")</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(lvf_xml_escape "$NODE_BIN")</string>
		<string>$(lvf_xml_escape "$LVF_CORE_ENTRY")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(lvf_xml_escape "$LVF_REPO_ROOT")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(lvf_xml_escape "$LAUNCHD_PATH")</string>
		<key>HOME</key>
		<string>$(lvf_xml_escape "$HOME")</string>
		<key>LANG</key>
		<string>en_US.UTF-8</string>
		<key>LVF_PORT</key>
		<string>$(lvf_xml_escape "$LVF_PORT")</string>
		<key>LVF_REPO_ROOT</key>
		<string>$(lvf_xml_escape "$LVF_REPO_ROOT")</string>
PLIST_HEAD

  if [[ -n "$VENV_PYTHON" ]]; then
    cat <<PLIST_PY
		<key>LVF_PYTHON</key>
		<string>$(lvf_xml_escape "$VENV_PYTHON")</string>
PLIST_PY
  fi

  cat <<PLIST_TAIL
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
		<key>Crashed</key>
		<true/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(lvf_xml_escape "$LVF_LOGS_DIR/core.out.log")</string>
	<key>StandardErrorPath</key>
	<string>$(lvf_xml_escape "$LVF_LOGS_DIR/core.err.log")</string>
</dict>
</plist>
PLIST_TAIL
} >"$LVF_PLIST"

plutil -lint "$LVF_PLIST" >/dev/null || die "the generated plist is invalid: $LVF_PLIST"
ok "plist written and linted"
note "KeepAlive: restart on crash or non-zero exit; a clean 'launchctl bootout' stays out."

step "Loading the LaunchAgent"

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LVF_AGENT_LABEL" >/dev/null 2>&1 || true
launchctl enable "gui/$UID_NUM/$LVF_AGENT_LABEL" >/dev/null 2>&1 || true

if launchctl bootstrap "gui/$UID_NUM" "$LVF_PLIST"; then
  ok "bootstrapped gui/$UID_NUM/$LVF_AGENT_LABEL"
else
  fail "launchctl bootstrap failed"
  hint "Inspect it with: launchctl print gui/$UID_NUM/$LVF_AGENT_LABEL"
  exit 1
fi

if lvf_wait_for_core 25; then
  ok "core is healthy on $LVF_BASE_URL"
else
  fail "core did not answer $LVF_BASE_URL/api/health within 25s"
  hint "Read the log: tail -n 50 \"$LVF_LOGS_DIR/core.err.log\""
  exit 1
fi

# ---------------------------------------------------------------------------
# App + dashboard
# ---------------------------------------------------------------------------

step "Menu-bar agent"

if [[ -d "$LVF_APP_BUNDLE" ]]; then
  ok "installed: $LVF_APP_BUNDLE"
  if ((OPEN_DASHBOARD == 1)); then
    open "$LVF_APP_BUNDLE" || warn "could not launch $LVF_APP_BUNDLE"
  fi
else
  warn "$LVF_APP_BUNDLE is not present (the Swift agent was skipped or failed to build)"
  hint "Run: make build"
fi

DASHBOARD_URL="$(lvf_dashboard_url)"

step "Готово"
if ((REINSTALL == 1)); then
  ok "Переустановлено поверх прежней версии, данные сохранены"
else
  ok "Установлено"
fi
printf '  Панель:  %s%s%s\n' "$LVF_C_BOLD" "$DASHBOARD_URL" "$LVF_C_RESET"
printf '  Логи:    %s\n' "$LVF_LOGS_DIR"
printf '  Данные:  %s\n' "$LVF_DATA_DIR"

# Разрешения — единственное, что отделяет пользователя от рабочей диктовки, и
# единственное, что нельзя сделать за него. Поэтому это последнее, что он видит.
MIC_STATE="$(lvf_api_get "/api/status" 2>/dev/null | lvf_json_find "microphone" 2>/dev/null || true)"
INP_STATE="$(lvf_api_get "/api/status" 2>/dev/null | lvf_json_find "inputMonitoring" 2>/dev/null || true)"
ACC_STATE="$(lvf_api_get "/api/status" 2>/dev/null | lvf_json_find "accessibility" 2>/dev/null || true)"

printf '\n'
if [[ "$MIC_STATE" == "granted" && "$INP_STATE" == "granted" && "$ACC_STATE" == "granted" ]]; then
  ok "Все разрешения macOS уже выданы — можно говорить"
  printf '  Зажмите %sFn%s, скажите фразу, отпустите. Проверка: %smake status%s\n' \
    "$LVF_C_BOLD" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
else
  warn "Осталось выдать разрешения macOS — без них диктовка не заработает"
  printf '\n  %sСледующий шаг:%s\n\n      %smake permissions%s\n\n' \
    "$LVF_C_BOLD" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '  Это пошаговый мастер: он сам откроет нужные окна системных настроек\n'
  printf '  и проверит результат.\n'
fi

if ((OPEN_DASHBOARD == 1)); then
  open "$DASHBOARD_URL" >/dev/null 2>&1 || warn "не удалось открыть браузер — скопируйте адрес выше"
fi

lvf_summary
exit 0
