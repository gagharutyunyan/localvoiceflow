#!/usr/bin/env bash
# Стабильная подпись приложения — то, что решает главную боль всей установки.
#
# macOS привязывает разрешения (микрофон, Универсальный доступ, Мониторинг ввода) не к
# имени приложения и не к его пути, а к его подписи. Без сертификата codesign подписывает
# ad-hoc, и тогда «подпись» — это просто хэш бинарника:
#
#     designated => cdhash H"d95ea38206..."
#
# Любая правка кода меняет хэш, и для macOS это уже другое приложение: все выданные
# разрешения аннулируются молча. Отсюда и брались бесконечные системные окна, и
# tccutil reset, и перезапуски приложения по кругу — всё это лечило симптом.
#
# С собственным сертификатом требование выглядит так:
#
#     designated => identifier "com.localvoiceflow.agent" and certificate leaf = H"23c11d..."
#
# Обе половины переживают пересборку, поэтому разрешения выдаются ровно один раз.
#
# Сертификат самоподписанный и живёт только на этой машине: он не делает приложение
# «доверенным» для чужих компьютеров и не заменяет Developer ID — он лишь даёт сборке
# постоянную личность. Настоящий Developer ID, если он появится в связке ключей, имеет
# приоритет, и этот скрипт тогда ничего не делает.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh"

CERT_NAME="LocalVoiceFlow Local Signing"
KEYCHAIN_NAME="localvoiceflow-signing.keychain"
KEYCHAIN_PATH="$HOME/Library/Keychains/${KEYCHAIN_NAME}-db"
# Отдельная связка ключей с пустым паролем вместо login.keychain — сознательно: доступ к
# ключу в login.keychain пришлось бы разблокировать паролем пользователя при каждой сборке
# (то самое окно «codesign хочет получить доступ»). Здесь ключ ничего не защищает: он
# нужен только чтобы подпись оставалась одной и той же.
KEYCHAIN_PASSWORD=""
CERT_DAYS=3650

# ---------------------------------------------------------------------------
# Уже есть чем подписывать?
# ---------------------------------------------------------------------------

step "Проверка сертификата для подписи"

developer_id() {
  security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1
}

local_identity_valid() {
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CERT_NAME"
}

EXISTING_DEV_ID="$(developer_id)"
if [[ -n "$EXISTING_DEV_ID" ]]; then
  ok "в связке ключей есть Developer ID: $EXISTING_DEV_ID"
  note "Он надёжнее локального сертификата — сборка будет подписываться им."
  exit 0
fi

if local_identity_valid; then
  ok "локальный сертификат «${CERT_NAME}» уже настроен"
  note "Разрешения macOS переживают пересборку — выдавать их заново не нужно."
  exit 0
fi

note "сертификата нет — создаю локальный, разово"

# ---------------------------------------------------------------------------
# Сертификат
# ---------------------------------------------------------------------------

command -v openssl >/dev/null 2>&1 || die "openssl не найден — он входит в macOS, проверьте PATH"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

step "Создаю сертификат"

# codeSigning в extendedKeyUsage обязателен: без него security find-identity -p codesigning
# не покажет сертификат, даже когда он лежит в связке ключей и доверен.
if ! openssl req -x509 -newkey rsa:2048 -sha256 -days "$CERT_DAYS" -nodes \
  -keyout "$WORK_DIR/key.pem" -out "$WORK_DIR/cert.pem" \
  -subj "/CN=${CERT_NAME}" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1; then
  die "openssl не смог создать сертификат"
fi
ok "сертификат создан (действителен $((CERT_DAYS / 365)) лет)"

# Связка ключей macOS не читает PKCS#12 в современных алгоритмах OpenSSL 3 и не умеет
# проверять MAC при пустом пароле, поэтому здесь намеренно старые -legacy алгоритмы и
# временный пароль, живущий только внутри этого скрипта.
P12_PASSWORD="localvoiceflow-import"
if ! openssl pkcs12 -export -out "$WORK_DIR/cert.p12" \
  -inkey "$WORK_DIR/key.pem" -in "$WORK_DIR/cert.pem" \
  -passout "pass:${P12_PASSWORD}" \
  -legacy -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES >/dev/null 2>&1; then
  die "openssl не смог упаковать сертификат в PKCS#12"
fi

# ---------------------------------------------------------------------------
# Связка ключей
# ---------------------------------------------------------------------------

step "Кладу сертификат в связку ключей"

# Повторный запуск после обрыва не должен плодить сертификаты: каждый добавленный
# остаётся в доверенных навсегда. Если ключ уже на месте, связка не трогается — чинить
# остаётся только доверие.
if security find-certificate -c "$CERT_NAME" "$KEYCHAIN_NAME" >/dev/null 2>&1; then
  ok "сертификат уже в связке ключей — переиспользую"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null 2>&1 || true
  # add-trusted-cert принимает только файл, поэтому существующий сертификат выгружается
  # обратно из связки.
  security find-certificate -c "$CERT_NAME" -p "$KEYCHAIN_NAME" >"$WORK_DIR/cert.pem" 2>/dev/null ||
    die "не удалось прочитать сертификат из связки ключей"
else
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null 2>&1 ||
    die "не удалось создать связку ключей $KEYCHAIN_NAME"
  # Без этого связка запирается через 5 минут простоя, и сборка начинает спрашивать пароль.
  security set-keychain-settings "$KEYCHAIN_NAME" >/dev/null 2>&1 || true
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null 2>&1 ||
    die "не удалось разблокировать связку ключей"

  if ! security import "$WORK_DIR/cert.p12" -k "$KEYCHAIN_NAME" -P "$P12_PASSWORD" \
    -T /usr/bin/codesign >/dev/null 2>&1; then
    die "не удалось импортировать сертификат в связку ключей"
  fi

  # ACL из -T мало: начиная с macOS 10.12 доступ к ключу дополнительно ограничен списком
  # разделов, и без этой строки codesign всё равно показал бы окно «разрешить доступ».
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" \
    "$KEYCHAIN_NAME" >/dev/null 2>&1 || true
  ok "сертификат импортирован"
fi

# codesign ищет ключи только в связках из пользовательского списка поиска, и флаг
# --keychain ему в этом не помогает — поэтому связку нужно добавить в список.
CURRENT_KEYCHAINS="$(security list-keychains -d user | sed 's/^[[:space:]]*"//;s/"$//')"
if ! printf '%s\n' "$CURRENT_KEYCHAINS" | grep -qF "$KEYCHAIN_NAME"; then
  # shellcheck disable=SC2046
  security list-keychains -d user -s $(printf '%s\n' "$CURRENT_KEYCHAINS" | tr '\n' ' ') \
    "$KEYCHAIN_PATH" >/dev/null 2>&1 || die "не удалось добавить связку в список поиска"
fi
ok "связка ключей добавлена в список поиска"

# ---------------------------------------------------------------------------
# Доверие
# ---------------------------------------------------------------------------

step "Помечаю сертификат доверенным для подписи кода"

# Без явного доверия codesign отвечает «no identity found»: сертификат в связке есть, но
# как удостоверение для подписи он не годится. Область — только текущий пользователь и
# только подпись кода: -p codeSign не даёт сертификату права, например, на HTTPS.
if ! security add-trusted-cert -r trustRoot -p codeSign \
  -k "$HOME/Library/Keychains/login.keychain-db" "$WORK_DIR/cert.pem" >/dev/null 2>&1; then
  fail "macOS не приняла сертификат в доверенные"
  hint "Если появлялось окно с паролем — запустите скрипт ещё раз и введите пароль"
  exit 1
fi

if local_identity_valid; then
  ok "сертификат «${CERT_NAME}» готов к работе"
else
  fail "сертификат создан, но codesign его не видит"
  hint "Проверьте: security find-identity -v -p codesigning"
  exit 1
fi

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------

step "Готово"
printf '  Сборка теперь подписывается постоянной личностью, поэтому разрешения macOS\n'
printf '  больше не слетают при пересборке.\n\n'
printf '  %sОдин раз%s осталось выдать три разрешения — приложение попросит их само\n' \
  "$LVF_C_BOLD" "$LVF_C_RESET"
printf '  при следующем запуске.\n\n'
printf '  Удалить сертификат, если он больше не нужен:\n'
printf '    security delete-keychain %s\n\n' "$KEYCHAIN_NAME"
lvf_summary
