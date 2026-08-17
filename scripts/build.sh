#!/usr/bin/env bash
#
# Builds every component and assembles ~/Applications/LocalVoiceFlow.app by hand.
# There is no Xcode project: the bundle is four files and a signature.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

SKIP_SWIFT=0

usage() {
  cat <<EOF
Usage: scripts/build.sh [options]

  --skip-swift   Do not run \`swift build\`. The .app is still re-assembled from a
                 previously built binary when one exists.
  -h, --help     Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-swift) SKIP_SWIFT=1 ;;
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

PNPM_BIN="$(lvf_pnpm)" || die "pnpm not found. Run scripts/bootstrap.sh first."

step "Building @lvf/shared"
(cd "$LVF_REPO_ROOT" && "$PNPM_BIN" --filter @lvf/shared build)
ok "packages/shared/dist"

step "Building @lvf/web (vite)"
(cd "$LVF_REPO_ROOT" && "$PNPM_BIN" --filter @lvf/web build)
ok "apps/web/dist"

step "Building @lvf/core (tsc)"
(cd "$LVF_REPO_ROOT" && "$PNPM_BIN" --filter @lvf/core build)
[[ -f "$LVF_CORE_ENTRY" ]] || die "expected $LVF_CORE_ENTRY after the core build"
ok "apps/core/dist"

# ---------------------------------------------------------------------------
# Swift agent
# ---------------------------------------------------------------------------

AGENT_BINARY=""

find_agent_binary() {
  local bin_dir="$1" candidate
  for candidate in "$LVF_AGENT_BINARY_NAME" LocalVoiceFlow lvf-agent; do
    if [[ -f "$bin_dir/$candidate" && -x "$bin_dir/$candidate" ]]; then
      printf '%s\n' "$bin_dir/$candidate"
      return 0
    fi
  done
  # Last resort: the single executable Mach-O in the release directory.
  local found
  found="$(find "$bin_dir" -maxdepth 1 -type f -perm -111 ! -name '*.dylib' ! -name '*.o' 2>/dev/null | head -n 1 || true)"
  [[ -n "$found" ]] || return 1
  printf '%s\n' "$found"
}

if [[ ! -f "$LVF_MAC_AGENT_DIR/Package.swift" ]]; then
  if ((SKIP_SWIFT == 1)); then
    warn "apps/mac-agent/Package.swift not found — skipping the Swift agent"
  else
    fail "apps/mac-agent/Package.swift not found"
    hint "The Swift agent is not in the tree yet. Build the rest with: scripts/build.sh --skip-swift"
    exit 1
  fi
else
  SWIFT_BIN="$(lvf_swift)" || die "swift not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
  SWIFT_BIN_DIR=""
  if ((SKIP_SWIFT == 1)); then
    step "Swift agent (skipped)"
    SWIFT_BIN_DIR="$("$SWIFT_BIN" build -c release --package-path "$LVF_MAC_AGENT_DIR" --show-bin-path 2>/dev/null || true)"
  else
    step "Building the Swift agent (release)"
    (cd "$LVF_MAC_AGENT_DIR" && "$SWIFT_BIN" build -c release)
    SWIFT_BIN_DIR="$("$SWIFT_BIN" build -c release --package-path "$LVF_MAC_AGENT_DIR" --show-bin-path)"
  fi

  if [[ -n "$SWIFT_BIN_DIR" && -d "$SWIFT_BIN_DIR" ]]; then
    AGENT_BINARY="$(find_agent_binary "$SWIFT_BIN_DIR" || true)"
  fi

  if [[ -n "$AGENT_BINARY" ]]; then
    ok "agent binary: $AGENT_BINARY"
  elif ((SKIP_SWIFT == 1)); then
    warn "no previously built agent binary found — the .app will not be re-assembled"
  else
    die "swift build produced no executable in ${SWIFT_BIN_DIR:-<unknown bin path>}"
  fi
fi

if [[ -z "$AGENT_BINARY" ]]; then
  step "Done (JS/TS only)"
  note "The .app bundle was left untouched: $LVF_APP_BUNDLE"
  lvf_summary
  exit 0
fi

# ---------------------------------------------------------------------------
# .app bundle
# ---------------------------------------------------------------------------

step "Assembling $LVF_APP_BUNDLE"

SOURCE_PLIST="$LVF_MAC_AGENT_DIR/Resources/Info.plist"
CONTENTS="$LVF_APP_BUNDLE/Contents"

mkdir -p "$HOME/Applications"
rm -rf "$LVF_APP_BUNDLE"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

if [[ -f "$SOURCE_PLIST" ]]; then
  cp "$SOURCE_PLIST" "$CONTENTS/Info.plist"
  ok "Info.plist from apps/mac-agent/Resources/Info.plist"
else
  cat >"$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>$LVF_AGENT_BINARY_NAME</string>
	<key>CFBundleIdentifier</key><string>$LVF_AGENT_LABEL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>$LVF_APP_NAME</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>0.1.0</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSUIElement</key><true/>
	<key>NSMicrophoneUsageDescription</key>
	<string>LocalVoiceFlow records your voice locally to transcribe it on this Mac.</string>
	<key>NSHumanReadableCopyright</key><string>Local, offline dictation. No telemetry.</string>
</dict>
</plist>
PLIST
  warn "apps/mac-agent/Resources/Info.plist missing — generated a minimal one"
  hint "Add the real Info.plist to apps/mac-agent/Resources/ so the agent controls its own bundle metadata"
fi

plutil -lint "$CONTENTS/Info.plist" >/dev/null || die "generated Info.plist is not a valid plist"

# The executable name inside the bundle must match CFBundleExecutable or launchd
# and Finder will refuse to start the app.
BUNDLE_EXECUTABLE="$(plutil -extract CFBundleExecutable raw -o - "$CONTENTS/Info.plist" 2>/dev/null || true)"
[[ -n "$BUNDLE_EXECUTABLE" ]] || BUNDLE_EXECUTABLE="$LVF_AGENT_BINARY_NAME"

cp "$AGENT_BINARY" "$CONTENTS/MacOS/$BUNDLE_EXECUTABLE"
chmod 755 "$CONTENTS/MacOS/$BUNDLE_EXECUTABLE"
ok "Contents/MacOS/$BUNDLE_EXECUTABLE"

# Everything else the agent ships (icons, sounds, nibs) travels as-is.
if [[ -d "$LVF_MAC_AGENT_DIR/Resources" ]]; then
  while IFS= read -r resource; do
    if [[ "$(basename "$resource")" == "Info.plist" ]]; then
      continue
    fi
    cp -R "$resource" "$CONTENTS/Resources/"
  done < <(find "$LVF_MAC_AGENT_DIR/Resources" -mindepth 1 -maxdepth 1 2>/dev/null)
fi

# start-core.sh is generated with absolute paths baked in: an app launched from
# Finder inherits none of the login shell's PATH.
NODE_BIN="$(lvf_node)" || die "node not found"
START_CORE_TEMPLATE="$LVF_BIN_DIR/start-core.sh"
[[ -f "$START_CORE_TEMPLATE" ]] || die "missing $START_CORE_TEMPLATE"

# awk's gsub() treats & in the replacement as "the whole match".
esc_root="${LVF_REPO_ROOT//&/\\&}"
esc_node="${NODE_BIN//&/\\&}"
awk -v root="$esc_root" -v node="$esc_node" -v port="$LVF_PORT" '
  { gsub(/@@REPO_ROOT@@/, root); gsub(/@@NODE_BIN@@/, node); gsub(/@@PORT@@/, port); print }
' "$START_CORE_TEMPLATE" >"$CONTENTS/Resources/start-core.sh"
chmod 755 "$CONTENTS/Resources/start-core.sh"
ok "Contents/Resources/start-core.sh (node: $NODE_BIN)"

printf 'APPL????' >"$CONTENTS/PkgInfo"
ok "Contents/PkgInfo"

if [[ ! -f "$CONTENTS/Resources/AppIcon.icns" ]]; then
  note "no AppIcon.icns — the bundle uses the generic app icon (cosmetic only)"
fi

# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

step "Signing"

DEVELOPER_ID="$(security find-identity -v -p codesigning 2>/dev/null |
  sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"

if [[ -n "$DEVELOPER_ID" ]]; then
  codesign --force --deep --options runtime --sign "$DEVELOPER_ID" "$LVF_APP_BUNDLE"
  ok "signed with Developer ID: $DEVELOPER_ID"
  note "Not notarized — Gatekeeper will still ask on first launch of a downloaded copy."
else
  codesign --force --deep --sign - "$LVF_APP_BUNDLE"
  ok "ad-hoc signed (no Developer ID identity in the keychain)"
  note "An ad-hoc signature changes on every rebuild, so macOS may re-ask for"
  note "Microphone / Accessibility / Input Monitoring after a rebuild."
fi

if codesign --verify --strict "$LVF_APP_BUNDLE" 2>/dev/null; then
  ok "signature verifies"
else
  fail "codesign --verify rejected the bundle"
  hint "Run: codesign --verify --verbose=4 \"$LVF_APP_BUNDLE\"  and fix what it reports"
fi

step "Done"
printf '  app:   %s\n' "$LVF_APP_BUNDLE"
printf '  core:  %s\n' "$LVF_CORE_ENTRY"
printf '  next:  make install\n'

lvf_summary
exit 0
