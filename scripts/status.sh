#!/usr/bin/env bash
# Один короткий ответ на вопрос «работает ли оно сейчас и можно ли говорить».
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'

yes_no() {
  # $1 = условие уже выполнено (0/1), $2 = подпись, $3 = подсказка при провале
  if (($1 == 0)); then
    printf '  %s●%s  %s\n' "$GREEN" "$RESET" "$2"
  else
    printf '  %s○%s  %s%s\n' "$RED" "$RESET" "$2" "${3:+  ${DIM}→ $3${RESET}}"
  fi
}

printf '\n%sLocalVoiceFlow%s\n\n' "$BOLD" "$RESET"

# --- ядро ---
CORE_UP=1
lvf_core_reachable && CORE_UP=0
yes_no "$CORE_UP" "Ядро (распознавание и история)" "make start"

# --- меню-бар приложение ---
AGENT_UP=1
pgrep -f "${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1 && AGENT_UP=0
yes_no "$AGENT_UP" "Приложение в строке меню" "open \"${LVF_APP_BUNDLE}\""

if ((CORE_UP != 0)); then
  printf '\n%sСостояние разрешений неизвестно, пока ядро не запущено.%s\n\n' "$DIM" "$RESET"
  exit 1
fi

STATUS_JSON="$(lvf_api_get "/api/status" 2>/dev/null || true)"
get() { printf '%s' "$STATUS_JSON" | lvf_json_find "$1" 2>/dev/null; }

# --- связь с агентом ---
if [[ "$(get agentConnected)" == "true" ]]; then
  printf '  %s●%s  Приложение на связи с ядром\n' "$GREEN" "$RESET"
else
  printf '  %s○%s  Приложение не отвечает ядру  %s→ make restart%s\n' "$RED" "$RESET" "$DIM" "$RESET"
fi

# --- модель ---
if [[ "$(get state)" == "ready" || "$(get ready)" == "true" ]]; then
  printf '  %s●%s  Модель распознавания загружена\n' "$GREEN" "$RESET"
else
  printf '  %s○%s  Модель ещё грузится  %s→ подождите несколько секунд%s\n' \
    "$YELLOW" "$RESET" "$DIM" "$RESET"
fi

# --- разрешения ---
MIC="$(get microphone)"; INP="$(get inputMonitoring)"; ACC="$(get accessibility)"
printf '\n%sРазрешения macOS%s\n' "$BOLD" "$RESET"
perm() {
  case "$2" in
    granted) printf '  %s●%s  %s\n' "$GREEN" "$RESET" "$1" ;;
    *)       printf '  %s○%s  %s  %s(%s)%s\n' "$RED" "$RESET" "$1" "$DIM" "$2" "$RESET" ;;
  esac
}
perm "Микрофон — записать голос" "$MIC"
perm "Мониторинг ввода — поймать Fn" "$INP"
perm "Универсальный доступ — вставить текст" "$ACC"

printf '\n'
if [[ "$MIC" == "granted" && "$INP" == "granted" && "$ACC" == "granted" ]] \
   && ((CORE_UP == 0)) && ((AGENT_UP == 0)); then
  printf '%s  Можно говорить: зажмите Fn, скажите фразу, отпустите.%s\n' "${GREEN}${BOLD}" "$RESET"
  printf '%s  Не реагирует Fn — попробуйте ⌃⌥Space.%s\n\n' "$DIM" "$RESET"
  exit 0
fi

printf '%s  Говорить пока нельзя.%s Выдайте разрешения: %smake permissions%s\n\n' \
  "$YELLOW" "$RESET" "$BOLD" "$RESET"
exit 1
