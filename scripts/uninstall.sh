#!/usr/bin/env bash
#
# Removes the LaunchAgent and the .app. User data is kept unless --purge is given,
# and --purge asks first.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

PURGE=0
ASSUME_YES=0

usage() {
  cat <<EOF
Usage: scripts/uninstall.sh [options]

  --purge     Also delete dictation history, audio and logs. Asks for confirmation.
  --yes       Skip the confirmation prompt (only meaningful with --purge).
  -h, --help  Show this help.

Without --purge nothing you dictated is deleted.
EOF
}

while (($# > 0)); do
  case "$1" in
    --purge) PURGE=1 ;;
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

step "Stopping LocalVoiceFlow"
"$LVF_BIN_DIR/stop.sh" --quiet || warn "stop.sh reported a problem; continuing"
ok "processes stopped"

step "LaunchAgent"
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LVF_AGENT_LABEL" >/dev/null 2>&1 || true
if [[ -f "$LVF_PLIST" ]]; then
  rm -f "$LVF_PLIST"
  ok "removed $LVF_PLIST"
else
  ok "no LaunchAgent plist to remove"
fi

step "Application"
if [[ -d "$LVF_APP_BUNDLE" ]]; then
  rm -rf "$LVF_APP_BUNDLE"
  ok "removed $LVF_APP_BUNDLE"
else
  ok "$LVF_APP_BUNDLE was not installed"
fi

# ---------------------------------------------------------------------------
# User data
# ---------------------------------------------------------------------------

safe_to_delete() {
  # Never let a mangled variable turn this into `rm -rf ~` or `rm -rf /`.
  case "$1" in
    "$HOME/Library/Application Support/$LVF_APP_NAME" | "$HOME/Library/Logs/$LVF_APP_NAME") return 0 ;;
    *) return 1 ;;
  esac
}

if ((PURGE == 0)); then
  step "User data kept"
  printf '  dictation history + settings: %s\n' "$LVF_DATA_DIR"
  printf '  stored audio:                 %s\n' "$LVF_AUDIO_DIR"
  printf '  logs:                         %s\n' "$LVF_LOGS_DIR"
  printf '\n  Delete all of it with: scripts/uninstall.sh --purge\n'
  lvf_summary
  exit 0
fi

step "Purging user data"
printf '  %s\n' "$LVF_DATA_DIR"
printf '  %s\n' "$LVF_AUDIO_DIR   (inside the data directory)"
printf '  %s\n' "$LVF_LOGS_DIR"
printf '\n  This deletes every dictation, every stored recording and the dictionary.\n'
printf '  It cannot be undone.\n\n'

if ((ASSUME_YES == 0)); then
  if [[ ! -t 0 ]]; then
    die "--purge needs an interactive confirmation. Re-run with --yes if you are sure."
  fi
  printf 'Type %sdelete%s to confirm: ' "$LVF_C_BOLD" "$LVF_C_RESET"
  read -r CONFIRMATION
  if [[ "$CONFIRMATION" != "delete" ]]; then
    warn "not confirmed — nothing was deleted"
    exit 1
  fi
fi

for target in "$LVF_DATA_DIR" "$LVF_LOGS_DIR"; do
  if ! safe_to_delete "$target"; then
    fail "refusing to delete an unexpected path: $target"
    continue
  fi
  if [[ -e "$target" ]]; then
    rm -rf "$target"
    ok "deleted $target"
  else
    ok "$target did not exist"
  fi
done

lvf_summary
exit 0
