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

restart_agent() {
  pkill -f "${LVF_AGENT_BINARY_NAME}" >/dev/null 2>&1 || true
  sleep 2
  open -a "${LVF_APP_BUNDLE}" >/dev/null 2>&1 || true
  sleep 4
}

# Приложение подписано ad-hoc, поэтому его подпись меняется при каждой пересборке.
# TCC запоминает не имя, а подпись — и старая строка в списке перестаёт совпадать с
# запущенным приложением. Снаружи это выглядит издевательски: галочка стоит, а доступа
# нет, и сколько её ни переключай, ничего не изменится.
#
# Поэтому перед тем как просить включить переключатель, удаляем прежнюю запись. Список
# станет пустым — это правильно: следующий запуск приложения добавит туда свежую строку,
# которая уже соответствует тому, что реально работает.
tcc_service_for() {
  case "$1" in
    microphone)      printf 'Microphone' ;;
    inputMonitoring) printf 'ListenEvent' ;;
    accessibility)   printf 'Accessibility' ;;
  esac
}

drop_stale_entry() {
  local service
  service="$(tcc_service_for "$1")"
  [[ -n "$service" ]] || return 0
  tccutil reset "$service" "${LVF_BUNDLE_ID}" >/dev/null 2>&1 || true
}

# Агент опрашивает TCC раз в 5 секунд, поэтому свежее состояние приезжает не мгновенно.
#
# Перезапуск во время ожидания обязателен, а не для надёжности: macOS кэширует ответ
# «Мониторинг ввода» на процесс, поэтому уже запущенное приложение продолжает видеть
# «denied» сколько угодно долго после того, как переключатель включён. Только новый
# процесс прочитает новое состояние — и он же заново попросит доступ, а этот запрос
# и создаёт строку приложения в списке System Settings.
wait_for_grant() {
  local key="$1" started=$SECONDS deadline=$((SECONDS + 180)) state last_restart=$SECONDS
  while ((SECONDS < deadline)); do
    state="$(read_permission "$key")"
    if [[ "$state" == "granted" ]]; then printf '\n'; return 0; fi

    # Отсчёт вслух: без него молчащая строка неотличима от зависшего скрипта.
    printf '\r    %sжду… %sс из 180 (Enter — пропустить шаг)%s   ' \
      "$LVF_C_DIM" "$((SECONDS - started))" "$LVF_C_RESET"

    if ((SECONDS - last_restart >= 20)); then
      last_restart=$SECONDS
      printf '\r    %sперезапускаю приложение, чтобы оно перечитало разрешение…%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
      restart_agent
    fi

    # `read -t` instead of `sleep`: the wait stays interruptible by Enter. On a
    # non-interactive stdin `read` returns instantly at EOF, turning this loop
    # into a busy-loop hammering HTTP — plain sleep there, nothing to interrupt.
    if [[ ! -t 0 ]]; then
      sleep 2
    elif read -r -t 2 -n 1 _skip 2>/dev/null; then
      printf '\n    %sшаг пропущен%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
      return 1
    fi
  done
  printf '\n'
  return 1
}

# ---------------------------------------------------------------------------
# Один шаг мастера
# ---------------------------------------------------------------------------

grant_step() {
  local number="$1" label="$2" key="$3" pane="$4" why="$5" where="$6"
  local state
  state="$(read_permission "$key")"

  printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
  printf '%sШаг %s из 3 — %s%s\n' "$LVF_C_BOLD" "$number" "$label" "$LVF_C_RESET"
  printf '%s%s%s\n' "$LVF_C_DIM" "$why" "$LVF_C_RESET"

  if [[ "$state" == "granted" ]]; then
    printf '%s  ✓ уже выдано — пропускаю%s\n' "$LVF_C_GREEN" "$LVF_C_RESET"
    return 0
  fi

  # Сначала убрать прежнюю запись, потом перезапустить приложение: свежий процесс просит
  # доступ, и именно этот запрос создаёт в списке строку с актуальной подписью. Порядок
  # важен — если сначала запустить, а потом сбросить, мы сотрём как раз то, что добавили.
  printf '\n  Убираю прежнюю запись из списка (она могла устареть)…\n'
  drop_stale_entry "$key"

  printf '  Прошу macOS о доступе (может появиться системное окно)…\n'
  restart_agent

  printf '  Открываю нужную панель системных настроек…\n'
  open "x-apple.systempreferences:com.apple.preference.security?${pane}" >/dev/null 2>&1 || true
  sleep 2

  printf '\n  %sЧто сделать в открывшемся окне:%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '    1. Найдите в списке %sLocalVoiceFlow%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '    2. %s\n' "$where"
  printf '    3. Если macOS попросит пароль — введите пароль от вашей учётной записи Mac\n'

  printf '\n  %sСписок пуст или LocalVoiceFlow в нём нет?%s Это бывает. Два способа:\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '    %sА.%s Я открыл окно Finder с приложением — просто %sперетащите его мышью%s\n' \
    "$LVF_C_BOLD" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '       из Finder прямо в список в системных настройках.\n'
  printf '    %sБ.%s Либо нажмите «+», затем ⌘⇧G, вставьте путь и Enter:\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '       %s%s%s\n' "$LVF_C_BOLD" "${LVF_APP_BUNDLE}" "$LVF_C_RESET"

  # Окно Finder с выделенным бандлом: перетащить мышью надёжнее, чем искать путь в
  # диалоге выбора файла, который открывается неизвестно где.
  open -R "${LVF_APP_BUNDLE}" >/dev/null 2>&1 || true

  printf '\n  %sВключили переключатель, а тут всё ещё «жду» — это нормально:%s macOS\n' "$LVF_C_DIM" "$LVF_C_RESET"
  printf '  %sотдаёт новое состояние только новому процессу, поэтому приложение%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
  printf '  %sперезапускается автоматически каждые 20 секунд.%s\n' "$LVF_C_DIM" "$LVF_C_RESET"

  printf '\n  Жду, пока разрешение появится… (Enter — пропустить, Ctrl+C — прервать)\n'
  if wait_for_grant "$key"; then
    printf '%s  ✓ %s — выдано%s\n' "$LVF_C_GREEN" "$label" "$LVF_C_RESET"
    return 0
  fi

  printf '%s  ✗ %s пока не выдано%s\n' "$LVF_C_YELLOW" "$label" "$LVF_C_RESET"
  hint "Проверьте, что галочка стоит именно у LocalVoiceFlow, и запустите: make permissions"
  return 1
}

# ---------------------------------------------------------------------------
# Мастер
# ---------------------------------------------------------------------------

printf '\n%sНастройка разрешений LocalVoiceFlow%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
printf '%sТри разрешения macOS. Без них диктовка не заработает — это защита системы,%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
printf '%sвыдать их можно только вручную.%s\n' "$LVF_C_DIM" "$LVF_C_RESET"

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

printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
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

printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
step "Проверка"

sleep 3
MIC="$(read_permission microphone)"
INP="$(read_permission inputMonitoring)"
ACC="$(read_permission accessibility)"

print_state() {
  case "$2" in
    granted) printf '  %s✓%s %-24s выдано\n' "$LVF_C_GREEN" "$LVF_C_RESET" "$1" ;;
    *)       printf '  %s✗%s %-24s %s\n' "$LVF_C_RED" "$LVF_C_RESET" "$1" "$2" ;;
  esac
}

print_state "Микрофон" "$MIC"
print_state "Мониторинг ввода" "$INP"
print_state "Универсальный доступ" "$ACC"

if [[ "$MIC" == "granted" && "$INP" == "granted" && "$ACC" == "granted" ]]; then
  printf '\n%s  Всё готово. Можно говорить.%s\n\n' "${LVF_C_GREEN}${LVF_C_BOLD}" "$LVF_C_RESET"
  printf '  %sКак проверить прямо сейчас:%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '    1. Откройте TextEdit и создайте новый документ\n'
  printf '    2. Поставьте курсор в документ\n'
  printf '    3. %sЗажмите Fn%s, скажите «привет это проверка диктовки», отпустите Fn\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '    4. Через пару секунд текст появится сам\n\n'
  printf '  Не сработала Fn — попробуйте %s⌃⌥Space%s (резервное сочетание).\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  printf '  История и настройки: %smake dashboard%s\n\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  exit 0
fi

printf '\n%s  Готово не полностью.%s\n\n' "$LVF_C_YELLOW" "$LVF_C_RESET"

# Незачем держать человека в заложниках у TCC: цепочка целиком работает и без этих
# двух разрешений. ⌃⌥Space — Carbon-хоткей, ему «Мониторинг ввода» не нужен, а без
# «Универсального доступа» текст просто остаётся в буфере обмена.
if [[ "$MIC" == "granted" ]]; then
  printf '  %sНо диктовать уже можно прямо сейчас:%s\n' "${LVF_C_GREEN}${LVF_C_BOLD}" "$LVF_C_RESET"
  printf '    1. Поставьте курсор туда, где нужен текст\n'
  printf '    2. Нажмите %s⌃⌥Space%s, скажите фразу, нажмите %s⌃⌥Space%s ещё раз\n' \
    "$LVF_C_BOLD" "$LVF_C_RESET" "$LVF_C_BOLD" "$LVF_C_RESET"
  if [[ "$ACC" == "granted" ]]; then
    printf '    3. Текст вставится сам\n'
  else
    printf '    3. Текст окажется в буфере обмена — нажмите %s⌘V%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
  fi
  printf '\n  %sЭто рабочий путь, а не заглушка.%s Разрешения нужны только для удобства:\n' \
    "$LVF_C_DIM" "$LVF_C_RESET"
  printf '  %sМониторинг ввода — чтобы работала клавиша Fn, Универсальный доступ —%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
  printf '  %sчтобы не нажимать ⌘V.%s\n\n' "$LVF_C_DIM" "$LVF_C_RESET"
fi

printf '  Попробовать выдать разрешения ещё раз: %smake permissions%s\n' "$LVF_C_BOLD" "$LVF_C_RESET"
printf '  %sЕсли приложения нет в списке — перетащите его туда мышью из Finder:%s\n' "$LVF_C_DIM" "$LVF_C_RESET"
printf '    %s%s%s\n\n' "$LVF_C_BOLD" "${LVF_APP_BUNDLE}" "$LVF_C_RESET"
exit 1
