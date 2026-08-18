#!/usr/bin/env bash
#
# Removes LocalVoiceFlow from the system.
#
# What "removed" means is a choice, not a constant: the app and its LaunchAgent always go, while
# dictation history, the macOS permission grants and the signing certificate each cost something
# to recreate and are therefore opt-in. `--all` is the answer to "I want this machine to look
# like it never had LocalVoiceFlow".
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

PURGE=0
RESET_PERMISSIONS=0
REMOVE_SIGNING=0
REMOVE_BUILD=0
ASSUME_YES=0

SIGNING_KEYCHAIN="localvoiceflow-signing.keychain"
SIGNING_CERT_NAME="LocalVoiceFlow Local Signing"

usage() {
  cat <<EOF
Usage: scripts/uninstall.sh [options]

  --purge        Also delete dictation history, stored audio and logs.
  --permissions  Also drop the macOS permission grants (Microphone, Fn, Accessibility),
                 so a fresh install asks for them again.
  --signing      Also delete the local signing certificate and its keychain.
  --build        Also delete build output (.build, dist) — not node_modules or the venv.
  --all          All of the above.
  --yes, -y      Skip the confirmation prompt.
  -h, --help     Show this help.

With no options the app, its LaunchAgent and its Login Items entry are removed, and
nothing you dictated is touched.
EOF
}

while (($# > 0)); do
  case "$1" in
    --purge) PURGE=1 ;;
    --permissions) RESET_PERMISSIONS=1 ;;
    --signing) REMOVE_SIGNING=1 ;;
    --build) REMOVE_BUILD=1 ;;
    --all)
      PURGE=1
      RESET_PERMISSIONS=1
      REMOVE_SIGNING=1
      REMOVE_BUILD=1
      ;;
    --yes | -y) ASSUME_YES=1 ;;
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

# ---------------------------------------------------------------------------
# Confirmation, once, listing exactly what will disappear
# ---------------------------------------------------------------------------

if ((PURGE == 1 || RESET_PERMISSIONS == 1 || REMOVE_SIGNING == 1)); then
  step "Что будет удалено"
  ((PURGE == 1)) && printf '  • история диктовок, записи и словарь: %s\n' "$LVF_DATA_DIR"
  ((PURGE == 1)) && printf '  • логи: %s\n' "$LVF_LOGS_DIR"
  ((RESET_PERMISSIONS == 1)) && printf '  • выданные разрешения macOS (их придётся выдать заново)\n'
  ((REMOVE_SIGNING == 1)) && printf '  • сертификат подписи и связка ключей «%s»\n' "$SIGNING_KEYCHAIN"
  ((REMOVE_BUILD == 1)) && printf '  • результаты сборки (.build, dist)\n'
  printf '\n  Отменить это нельзя.\n\n'

  if ((ASSUME_YES == 0)); then
    if [[ ! -t 0 ]]; then
      die "нужно подтверждение с клавиатуры. Если уверены — добавьте --yes"
    fi
    printf 'Введите %sdelete%s для подтверждения: ' "$LVF_C_BOLD" "$LVF_C_RESET"
    read -r CONFIRMATION
    if [[ "$CONFIRMATION" != "delete" ]]; then
      warn "не подтверждено — ничего не удалено"
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Login Items — до удаления бандла: снять регистрацию может только само приложение
# ---------------------------------------------------------------------------

step "Автозапуск"

AGENT_EXECUTABLE="$LVF_APP_BUNDLE/Contents/MacOS/$LVF_AGENT_BINARY_NAME"
if [[ -x "$AGENT_EXECUTABLE" ]]; then
  if "$AGENT_EXECUTABLE" --unregister-login-item >/dev/null 2>&1; then
    ok "приложение убрано из «Объектов входа»"
  else
    # Не повод останавливаться: запись без приложения macOS и сама уберёт, просто позже.
    warn "не удалось снять регистрацию — macOS уберёт запись сама после удаления приложения"
  fi
else
  ok "приложение не установлено — снимать нечего"
fi

# ---------------------------------------------------------------------------
# Процессы и LaunchAgent
# ---------------------------------------------------------------------------

step "Остановка"
"$LVF_BIN_DIR/stop.sh" --quiet || warn "stop.sh сообщил о проблеме; продолжаю"
ok "процессы остановлены"

step "LaunchAgent"
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LVF_AGENT_LABEL" >/dev/null 2>&1 || true
if [[ -f "$LVF_PLIST" ]]; then
  rm -f "$LVF_PLIST"
  ok "удалён $LVF_PLIST"
else
  ok "plist отсутствует"
fi

# Порядок важен: tccutil находит приложение через Launch Services, поэтому со стёртым
# бандлом он отвечает «No such bundle identifier» и записи остаются в системе навсегда.
if ((RESET_PERMISSIONS == 1)); then
  step "Разрешения macOS"
  for service in Microphone ListenEvent Accessibility; do
    if tccutil reset "$service" "$LVF_BUNDLE_ID" >/dev/null 2>&1; then
      ok "сброшено: $service"
    else
      warn "не удалось сбросить $service (возможно, записи и не было)"
    fi
  done
fi

step "Приложение"
if [[ -d "$LVF_APP_BUNDLE" ]]; then
  rm -rf "$LVF_APP_BUNDLE"
  ok "удалено $LVF_APP_BUNDLE"
else
  ok "$LVF_APP_BUNDLE не был установлен"
fi

# ---------------------------------------------------------------------------
# Сертификат подписи
# ---------------------------------------------------------------------------

if ((REMOVE_SIGNING == 1)); then
  step "Сертификат подписи"

  # Доверие снимается по файлу сертификата, поэтому его нужно выгрузить до удаления связки.
  CERT_FILE="$(mktemp)"
  if security find-certificate -c "$SIGNING_CERT_NAME" -p "$SIGNING_KEYCHAIN" >"$CERT_FILE" 2>/dev/null; then
    if security remove-trusted-cert "$CERT_FILE" >/dev/null 2>&1; then
      ok "снято доверие к сертификату"
    else
      warn "не удалось снять доверие — сертификат останется в списке доверенных"
    fi
  fi
  rm -f "$CERT_FILE"

  # Связку нужно убрать и из списка поиска: удалённая связка оставляет там мёртвую строку.
  CURRENT_KEYCHAINS="$(security list-keychains -d user | sed 's/^[[:space:]]*"//;s/"$//')"
  REMAINING="$(printf '%s\n' "$CURRENT_KEYCHAINS" | grep -vF "$SIGNING_KEYCHAIN" || true)"
  if [[ "$REMAINING" != "$CURRENT_KEYCHAINS" ]]; then
    # shellcheck disable=SC2046
    security list-keychains -d user -s $(printf '%s\n' "$REMAINING" | tr '\n' ' ') >/dev/null 2>&1 || true
    ok "связка убрана из списка поиска"
  fi

  if security delete-keychain "$SIGNING_KEYCHAIN" >/dev/null 2>&1; then
    ok "связка ключей удалена"
  else
    ok "связки ключей не было"
  fi
fi

# ---------------------------------------------------------------------------
# Данные пользователя
# ---------------------------------------------------------------------------

safe_to_delete() {
  # Никакая испорченная переменная не должна превратить это в `rm -rf ~` или `rm -rf /`.
  case "$1" in
    "$HOME/Library/Application Support/$LVF_APP_NAME" | "$HOME/Library/Logs/$LVF_APP_NAME") return 0 ;;
    *) return 1 ;;
  esac
}

if ((PURGE == 1)); then
  step "Данные"
  for target in "$LVF_DATA_DIR" "$LVF_LOGS_DIR"; do
    if ! safe_to_delete "$target"; then
      fail "отказываюсь удалять неожиданный путь: $target"
      continue
    fi
    if [[ -e "$target" ]]; then
      rm -rf "$target"
      ok "удалено $target"
    else
      ok "$target не существовал"
    fi
  done
else
  step "Данные сохранены"
  printf '  история и настройки: %s\n' "$LVF_DATA_DIR"
  printf '  логи:                %s\n' "$LVF_LOGS_DIR"
  printf '\n  Удалить и их: scripts/uninstall.sh --purge\n'
fi

# ---------------------------------------------------------------------------
# Результаты сборки
# ---------------------------------------------------------------------------

if ((REMOVE_BUILD == 1)); then
  step "Результаты сборки"
  # node_modules и Python venv остаются намеренно: их восстановление тянет сотни мегабайт,
  # а на проверку установки они не влияют — make bootstrap переиспользует готовые.
  for target in \
    "$LVF_REPO_ROOT/apps/mac-agent/.build" \
    "$LVF_REPO_ROOT/apps/core/dist" \
    "$LVF_REPO_ROOT/apps/web/dist" \
    "$LVF_REPO_ROOT/packages/shared/dist"; do
    if [[ -e "$target" ]]; then
      rm -rf "$target"
      ok "удалено ${target#"$LVF_REPO_ROOT"/}"
    fi
  done
  note "node_modules и Python venv оставлены — удалите вручную, если нужен полностью чистый старт"
fi

lvf_summary
exit 0
