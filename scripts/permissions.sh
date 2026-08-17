#!/usr/bin/env bash
# Пошаговая выдача трёх разрешений macOS, без которых диктовка физически не работает.
#
# TCC нельзя выдать программно — это защита самой macOS. Поэтому скрипт делает всё, что
# может: открывает нужную панель, говорит, что именно нажать, и сам проверяет результат,
# чтобы не пришлось гадать, засчиталось или нет.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'

# ---------------------------------------------------------------------------
# Подготовка: без core и агента состояние разрешений прочитать невозможно
# ---------------------------------------------------------------------------

step "Подготовка"

if ! lvf_core_reachable; then
  note "Core не запущен — запускаю"
  "${SCRIPT_DIR}/start-core.sh" >/dev/null 2>&1 || true
  lvf_wait_for_core 30 || true
fi

if lvf_core_reachable; then
  ok "Core отвечает на ${LVF_BASE_URL}"
else
  fail "Core не поднялся"
  hint "Запустите вручную: make start   — и посмотрите ${LVF_CORE_LOG}"
  exit 1
fi

if [[ ! -d "${LVF_APP_BUNDLE}" ]]; then
  fail "Приложение не собрано: ${LVF_APP_BUNDLE}"
  hint "Соберите его: make build"
  exit 1
fi

if ! pgrep -f "${LVF_APP_BUNDLE}/Contents/MacOS/${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1; then
  note "Меню-бар приложение не запущено — запускаю"
  open -a "${LVF_APP_BUNDLE}" >/dev/null 2>&1 || true
  sleep 3
fi

if pgrep -f "${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1; then
  ok "Меню-бар приложение запущено (иконка микрофона в строке меню)"
else
  fail "Меню-бар приложение не запускается"
  hint "Откройте вручную: open \"${LVF_APP_BUNDLE}\""
  exit 1
fi

# ---------------------------------------------------------------------------
# Чтение состояния
# ---------------------------------------------------------------------------

read_permission() {
  # $1 = ключ (microphone | accessibility | inputMonitoring)
  local json
  json="$(lvf_api_get "/api/status" 2>/dev/null || true)"
  printf '%s' "$json" | lvf_json_find "$1" 2>/dev/null || printf 'unknown'
}

agent_online() {
  local json
  json="$(lvf_api_get "/api/status" 2>/dev/null || true)"
  [[ "$(printf '%s' "$json" | lvf_json_find "agentConnected" 2>/dev/null)" == "true" ]]
}

# Агент опрашивает TCC раз в 5 секунд, поэтому свежее состояние приезжает не мгновенно.
wait_for_grant() {
  local key="$1" deadline=$((SECONDS + 90)) state
  while ((SECONDS < deadline)); do
    state="$(read_permission "$key")"
    if [[ "$state" == "granted" ]]; then return 0; fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------------------
# Один шаг мастера
# ---------------------------------------------------------------------------

grant_step() {
  local number="$1" label="$2" key="$3" pane="$4" why="$5" where="$6"
  local state
  state="$(read_permission "$key")"

  printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
  printf '%sШаг %s из 3 — %s%s\n' "$BOLD" "$number" "$label" "$RESET"
  printf '%s%s%s\n' "$DIM" "$why" "$RESET"

  if [[ "$state" == "granted" ]]; then
    printf '%s  ✓ уже выдано — пропускаю%s\n' "$GREEN" "$RESET"
    return 0
  fi

  printf '\n  Открываю нужную панель системных настроек…\n'
  open "x-apple.systempreferences:com.apple.preference.security?${pane}" >/dev/null 2>&1 || true
  sleep 2

  printf '\n  %sЧто сделать в открывшемся окне:%s\n' "$BOLD" "$RESET"
  printf '    1. Найдите в списке %sLocalVoiceFlow%s\n' "$BOLD" "$RESET"
  printf '    2. %s\n' "$where"
  printf '    3. Если macOS попросит пароль — введите пароль от вашей учётной записи Mac\n'
  printf '\n  %sЕсли LocalVoiceFlow нет в списке:%s нажмите «+», затем ⌘⇧G,\n' "$BOLD" "$RESET"
  printf '  вставьте путь и нажмите Enter:\n'
  printf '    %s%s%s\n' "$BOLD" "${LVF_APP_BUNDLE}" "$RESET"

  printf '\n  Жду, пока разрешение появится… (Ctrl+C — прервать)\n'
  if wait_for_grant "$key"; then
    printf '%s  ✓ %s — выдано%s\n' "$GREEN" "$label" "$RESET"
    return 0
  fi

  printf '%s  ✗ %s пока не выдано%s\n' "$YELLOW" "$label" "$RESET"
  hint "Проверьте, что галочка стоит именно у LocalVoiceFlow, и запустите: make permissions"
  return 1
}

# ---------------------------------------------------------------------------
# Мастер
# ---------------------------------------------------------------------------

printf '\n%sНастройка разрешений LocalVoiceFlow%s\n' "$BOLD" "$RESET"
printf '%sТри разрешения macOS. Без них диктовка не заработает — это защита системы,%s\n' "$DIM" "$RESET"
printf '%sвыдать их можно только вручную.%s\n' "$DIM" "$RESET"

FAILED=0

grant_step 1 "Микрофон" "microphone" "Privacy_Microphone" \
  "Чтобы записывать голос." \
  "Включите переключатель напротив LocalVoiceFlow" || FAILED=1

grant_step 2 "Мониторинг ввода" "inputMonitoring" "Privacy_ListenEvent" \
  "Чтобы поймать нажатие Fn в любом приложении. Без него клавиша Fn не работает." \
  "Включите переключатель напротив LocalVoiceFlow" || FAILED=1

grant_step 3 "Универсальный доступ" "accessibility" "Privacy_Accessibility" \
  "Чтобы вставить готовый текст в поле, где стоит курсор." \
  "Включите переключатель напротив LocalVoiceFlow" || FAILED=1

# ---------------------------------------------------------------------------
# Перезапуск: event tap подхватывает новые права только при старте процесса
# ---------------------------------------------------------------------------

printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
step "Перезапуск приложения"
note "macOS отдаёт новые права только при запуске процесса, поэтому перезапускаю"

pkill -f "${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1 || true
sleep 2
open -a "${LVF_APP_BUNDLE}" >/dev/null 2>&1 || true
sleep 4

# ---------------------------------------------------------------------------
# Клавиша 🌐 / Fn может быть перехвачена самой macOS
# ---------------------------------------------------------------------------

step "Клавиша Fn"

FN_USAGE="$(defaults read com.apple.HIToolbox AppleFnUsageType 2>/dev/null || printf 'unset')"
case "$FN_USAGE" in
  0)
    ok "Клавиша 🌐/Fn ничем не занята в системе"
    ;;
  1|2|3|unset)
    case "$FN_USAGE" in
      1) BUSY="сменой языка ввода" ;;
      2) BUSY="показом эмодзи" ;;
      3) BUSY="системной диктовкой" ;;
      *) BUSY="системным действием по умолчанию" ;;
    esac
    warn "Клавиша 🌐/Fn может быть занята: ${BUSY}"
    hint "Если Fn не срабатывает: Системные настройки → Клавиатура →"
    hint "  «При нажатии 🌐» → выберите «Ничего не делать»"
    hint "Либо пользуйтесь резервным сочетанием ⌃⌥Space — оно работает всегда"
    ;;
esac

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------

printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
step "Проверка"

sleep 3
MIC="$(read_permission microphone)"
INP="$(read_permission inputMonitoring)"
ACC="$(read_permission accessibility)"

print_state() {
  case "$2" in
    granted) printf '  %s✓%s %-24s выдано\n' "$GREEN" "$RESET" "$1" ;;
    *)       printf '  %s✗%s %-24s %s\n' "$RED" "$RESET" "$1" "$2" ;;
  esac
}

print_state "Микрофон" "$MIC"
print_state "Мониторинг ввода" "$INP"
print_state "Универсальный доступ" "$ACC"

if [[ "$MIC" == "granted" && "$INP" == "granted" && "$ACC" == "granted" ]]; then
  printf '\n%s  Всё готово. Можно говорить.%s\n\n' "${GREEN}${BOLD}" "$RESET"
  printf '  %sКак проверить прямо сейчас:%s\n' "$BOLD" "$RESET"
  printf '    1. Откройте TextEdit и создайте новый документ\n'
  printf '    2. Поставьте курсор в документ\n'
  printf '    3. %sЗажмите Fn%s, скажите «привет это проверка диктовки», отпустите Fn\n' "$BOLD" "$RESET"
  printf '    4. Через пару секунд текст появится сам\n\n'
  printf '  Не сработала Fn — попробуйте %s⌃⌥Space%s (резервное сочетание).\n' "$BOLD" "$RESET"
  printf '  История и настройки: %smake dashboard%s\n\n' "$BOLD" "$RESET"
  exit 0
fi

printf '\n%s  Готово не полностью.%s Запустите ещё раз: %smake permissions%s\n\n' \
  "$YELLOW" "$RESET" "$BOLD" "$RESET"
exit 1
