#!/usr/bin/env bash
# Generates the audio fixtures used by `make benchmark` and "Test transcription".
#
# Real speech would be better, but a committed recording of the user's voice is not
# something that belongs in a repository. macOS `say` with the Russian voice Milena gives
# a deterministic, reproducible stand-in that exercises the same code path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_lib.sh" 2>/dev/null || true

ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${ROOT}/fixtures/audio"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${OUT_DIR}"

if ! command -v say >/dev/null 2>&1; then
  echo "[FAIL] \`say\` not found — this script only runs on macOS" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[FAIL] ffmpeg not found. Install it with: brew install ffmpeg" >&2
  exit 1
fi

if ! say -v '?' | grep -q '^Milena'; then
  echo "[WARN] The Russian voice \"Milena\" is not installed." >&2
  echo "       System Settings → Accessibility → Spoken Content → System Voice → Manage Voices" >&2
  echo "       Install \"Milena (ru_RU)\", then run this again." >&2
  exit 1
fi

# id|text
FIXTURES=(
  "ru-useeffect|так смотри этот юз эффект каждый раз когда обновляется юзер дата снова вызывает фетч надо это убрать"
  "ru-user-profile|создай компонент юзер профайл который принимает юзер айди через пропсы"
  "ru-react-query|в реакт квери нужно инвалидировать квери после мутации"
  "ru-abort-controller|добавь аборт контроллер и отмени запрос в клинапе юз эффекта"
  "ru-pnpm-dev|перейди в папку фронтенд и запусти пи эн пи эм дев"
)

for entry in "${FIXTURES[@]}"; do
  id="${entry%%|*}"
  text="${entry#*|}"
  aiff="${TMP_DIR}/${id}.aiff"
  wav="${OUT_DIR}/${id}.wav"

  say -v Milena -o "${aiff}" "${text}"
  # 16 kHz mono PCM is exactly what the STT worker expects, so no runtime transcode.
  ffmpeg -v error -y -i "${aiff}" -ac 1 -ar 16000 -c:a pcm_s16le "${wav}"
  printf '[OK] %s (%s bytes)\n' "${wav}" "$(stat -f%z "${wav}")"
done

# A deliberately silent capture, so the no-speech path can be regression-tested.
ffmpeg -v error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 1.5 -c:a pcm_s16le \
  "${OUT_DIR}/silence.wav"
printf '[OK] %s (silence, for the no-speech path)\n' "${OUT_DIR}/silence.wav"

echo
echo "Fixtures written to ${OUT_DIR}"
echo "They are git-ignored: generated audio does not belong in the repository."
