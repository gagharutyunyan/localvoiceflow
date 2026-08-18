#!/usr/bin/env bash
#
# stop.sh, then start.sh. Any arguments are forwarded to start.sh.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: scripts/restart.sh [start.sh options]

Stops core and the agent, then starts them again. A LaunchAgent-managed install
stays LaunchAgent-managed. Options are passed through to scripts/start.sh
(--no-agent, --open, --wait <sec>).
EOF
  exit 0
fi

WAS_LAUNCHD_MANAGED=0
if lvf_launchagent_loaded; then
  WAS_LAUNCHD_MANAGED=1
fi

"$LVF_BIN_DIR/stop.sh" --quiet

# launchd needs a moment to release the listening socket before core rebinds it.
WAITED=0
while lvf_port_in_use "$LVF_PORT" && ((WAITED < 50)); do
  sleep 0.1
  WAITED=$((WAITED + 1))
done

# stop.sh boots the job out; put it back so a restart does not quietly downgrade a
# managed install into a hand-started process.
if ((WAS_LAUNCHD_MANAGED == 1)) && [[ -f "$LVF_PLIST" ]]; then
  step "Reloading the LaunchAgent"
  # `bootout` returns before launchd has finished retiring the label, and a `bootstrap`
  # that lands in that window fails with "Input/output error" (errno 5) — which is what
  # made every `make restart` drop the install to a hand-started core. Wait the label out
  # instead of racing it.
  # Only a bootstrap that actually returns 0 counts: during the teardown window the label
  # is still printable, so asking `launchctl print` whether the job is loaded answers
  # "yes" about a job that is on its way out.
  BOOTSTRAPPED=0
  for _ in $(seq 1 40); do
    if launchctl bootstrap "gui/$(id -u)" "$LVF_PLIST" 2>/dev/null; then
      BOOTSTRAPPED=1
      break
    fi
    sleep 0.25
  done
  if ((BOOTSTRAPPED == 1)); then
    ok "bootstrapped $LVF_AGENT_LABEL"
  else
    fail "launchctl bootstrap failed — falling back to a hand-started core"
    hint "Inspect it with: launchctl print gui/$(id -u)/$LVF_AGENT_LABEL"
    # Show the real error once, now that the retries are exhausted.
    launchctl bootstrap "gui/$(id -u)" "$LVF_PLIST" || true
  fi
fi

exec "$LVF_BIN_DIR/start.sh" "$@"
