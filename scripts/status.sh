#!/usr/bin/env bash
# Один короткий ответ на вопрос «работает ли оно сейчас и можно ли говорить».
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh"

yes_no() {
  # $1 = условие уже выполнено (0/1), $2 = подпись, $3 = подсказка при провале
  if (($1 == 0)); then
    printf '  %s●%s  %s\n' "$LVF_C_GREEN" "$LVF_C_RESET" "$2"
  else
    printf '  %s○%s  %s%s\n' "$LVF_C_RED" "$LVF_C_RESET" "$2" "${3:+  ${LVF_C_DIM}→ $3${LVF_C_RESET}}"
  fi
}

printf '\n%sLocalVoiceFlow%s\n\n' "$LVF_C_BOLD" "$LVF_C_RESET"

# --- ядро ---
CORE_UP=1
lvf_core_reachable && CORE_UP=0
yes_no "$CORE_UP" "Ядро (распознавание и история)" "make start"

# --- меню-бар приложение ---
AGENT_UP=1
pgrep -f "${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1 && AGENT_UP=0
yes_no "$AGENT_UP" "Приложение в строке меню" "open \"${LVF_APP_BUNDLE}\""

if ((CORE_UP != 0)); then
  printf '\n%sСостояние разрешений неизвестно, пока ядро не запущено.%s\n\n' "$LVF_C_DIM" "$LVF_C_RESET"
  exit 1
fi

STATUS_JSON="$(lvf_api_get "/api/status" 2>/dev/null || true)"
get() { printf '%s' "$STATUS_JSON" | lvf_json_find "$1" 2>/dev/null; }

# --- связь с агентом ---
if [[ "$(get agentConnected)" == "true" ]]; then
  printf '  %s●%s  Приложение на связи с ядром\n' "$LVF_C_GREEN" "$LVF_C_RESET"
else
  printf '  %s○%s  Приложение не отвечает ядру  %s→ make restart%s\n' "$LVF_C_RED" "$LVF_C_RESET" "$LVF_C_DIM" "$LVF_C_RESET"
fi

# --- модель ---
if [[ "$(get state)" == "ready" || "$(get ready)" == "true" ]]; then
  printf '  %s●%s  Модель распознавания загружена\n' "$LVF_C_GREEN" "$LVF_C_RESET"
else
  printf '  %s○%s  Модель ещё грузится  %s→ подождите несколько секунд%s\n' \
    "$LVF_C_YELLOW" "$LVF_C_RESET" "$LVF_C_DIM" "$LVF_C_RESET"
fi

# --- разрешения ---
MIC="$(get microphone)"; INP="$(get inputMonitoring)"; ACC="$(get accessibility)"
printf '\n%sРазрешения macOS%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
perm() {
  case "$2" in
    granted) printf '  %s●%s  %s\n' "$LVF_C_GREEN" "$LVF_C_RESET" "$1" ;;
    *)       printf '  %s○%s  %s  %s(%s)%s\n' "$LVF_C_RED" "$LVF_C_RESET" "$1" "$LVF_C_DIM" "$2" "$LVF_C_RESET" ;;
  esac
}
perm "Микрофон — записать голос" "$MIC"
perm "Мониторинг ввода — поймать Fn" "$INP"
perm "Универсальный доступ — вставить текст" "$ACC"

printf '\n'
if [[ "$MIC" == "granted" && "$INP" == "granted" && "$ACC" == "granted" ]] \
   && ((CORE_UP == 0)) && ((AGENT_UP == 0)); then
  printf '%s  Можно говорить: зажмите Fn, скажите фразу, отпустите.%s\n' "${LVF_C_GREEN}${LVF_C_BOLD}" "$LVF_C_RESET"
  printf '%s  Не реагирует Fn — попробуйте ⌃⌥Space.%s\n\n' "$LVF_C_DIM" "$LVF_C_RESET"
  exit 0
fi

# «Мониторинг ввода» и «Универсальный доступ» — это удобство, а не условие работы:
# ⌃⌥Space зарегистрировано через Carbon и обходится без TCC, а текст без
# «Универсального доступа» кладётся в буфер обмена. Писать «говорить нельзя» в этом
# случае — врать пользователю о собственной программе.
if [[ "$MIC" == "granted" ]] && ((CORE_UP == 0)) && ((AGENT_UP == 0)); then
  printf '%s  Говорить можно уже сейчас — через резервное сочетание:%s\n' "${LVF_C_GREEN}${LVF_C_BOLD}" "$LVF_C_RESET"
  printf '    %s⌃⌥Space%s → фраза → %s⌃⌥Space%s' "$LVF_C_BOLD" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
  if [[ "$ACC" == "granted" ]]; then
    printf ' → текст вставится сам\n'
  else
    printf ' → %s⌘V%s (текст ждёт в буфере обмена)\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  fi
  printf '\n%s  Чтобы заработала клавиша Fn и вставка без ⌘V: %smake permissions%s\n\n' \
    "$LVF_C_DIM" "$LVF_C_BOLD" "$LVF_C_RESET"
  exit 0
fi

# The advice must name the actual blocker: with every permission granted the only
# thing missing is a running core/agent, and «выдайте разрешения» would be a lie.
if [[ "$MIC" == "granted" && "$INP" == "granted" && "$ACC" == "granted" ]]; then
  printf '%s  Говорить пока нельзя.%s Разрешения выданы — не запущено приложение: %smake start%s\n\n' \
    "$LVF_C_YELLOW" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
else
  printf '%s  Говорить пока нельзя.%s Выдайте разрешения: %smake permissions%s\n\n' \
    "$LVF_C_YELLOW" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
fi
exit 1
