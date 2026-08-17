#!/usr/bin/env bash
#
# Thin driver for core's benchmark entrypoint. All measurement lives in
# apps/core/src/benchmark.ts — this only resolves paths and forwards flags.
#
# Running with an LLM provider spends the user's subscription quota, so --skip-llm
# is offered up front and the run is announced before it starts.
set -euo pipefail

LVF_BIN_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/_lib.sh
source "$LVF_BIN_DIR/_lib.sh"

usage() {
  cat <<EOF
Usage: scripts/benchmark.sh [options] [-- extra args for benchmark.js]

  --provider <id>   claude-cli | openai-codex-cli | mock
  --model <id>      Model id passed to the provider.
  --effort <level>  claude: low|medium|high|xhigh|max   codex: none|low|medium|high|xhigh|max
  --runs <n>        Number of iterations per case.
  --skip-llm        Measure STT only; no subscription quota is spent.
  --json <file>     Also write machine-readable results to <file>.
  -h, --help        Show this help.

Anything after -- is forwarded to apps/core/dist/benchmark.js untouched.
EOF
}

declare -a FORWARD=()
JSON_OUT=""
SKIP_LLM=0
PROVIDER=""

require_value() {
  [[ -n "${2:-}" ]] || die "$1 needs a value"
}

while (($# > 0)); do
  case "$1" in
    --provider)
      require_value --provider "${2:-}"
      PROVIDER="$2"
      FORWARD+=("--provider=$2")
      shift
      ;;
    --provider=*)
      PROVIDER="${1#*=}"
      FORWARD+=("$1")
      ;;
    --model)
      require_value --model "${2:-}"
      FORWARD+=("--model=$2")
      shift
      ;;
    --model=*) FORWARD+=("$1") ;;
    --effort)
      require_value --effort "${2:-}"
      FORWARD+=("--effort=$2")
      shift
      ;;
    --effort=*) FORWARD+=("$1") ;;
    --runs)
      require_value --runs "${2:-}"
      FORWARD+=("--runs=$2")
      shift
      ;;
    --runs=*) FORWARD+=("$1") ;;
    --skip-llm)
      SKIP_LLM=1
      FORWARD+=("--skip-llm")
      ;;
    --json)
      require_value --json "${2:-}"
      JSON_OUT="$2"
      shift
      ;;
    --json=*) JSON_OUT="${1#*=}" ;;
    --)
      shift
      while (($# > 0)); do
        FORWARD+=("$1")
        shift
      done
      break
      ;;
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

if [[ ! -f "$LVF_BENCH_ENTRY" ]]; then
  fail "benchmark entrypoint not found: $LVF_BENCH_ENTRY"
  hint "Build core first: make build   (it compiles apps/core/src/benchmark.ts)"
  exit 2
fi

NODE_BIN="$(lvf_node)" || die "node not found. Run scripts/bootstrap.sh."

# Make the output path absolute before handing it over: benchmark.js may run with a
# different working directory than this shell.
if [[ -n "$JSON_OUT" ]]; then
  case "$JSON_OUT" in
    /*) : ;;
    *) JSON_OUT="$PWD/$JSON_OUT" ;;
  esac
  mkdir -p "$(dirname "$JSON_OUT")"
  FORWARD+=("--json=$JSON_OUT")
fi

step "Benchmark"
printf '  entry:    %s\n' "$LVF_BENCH_ENTRY"
printf '  provider: %s\n' "${PROVIDER:-<core default>}"
if ((SKIP_LLM == 1)); then
  printf '  llm:      skipped (--skip-llm), no subscription quota is spent\n'
else
  printf '  %sllm:      enabled — this spends your paid subscription quota%s\n' \
    "$LVF_C_YELLOW" "$LVF_C_RESET"
fi
[[ -n "$JSON_OUT" ]] && printf '  json:     %s\n' "$JSON_OUT"
printf '\n'

cd "$LVF_REPO_ROOT"
set +e
"$NODE_BIN" "$LVF_BENCH_ENTRY" ${FORWARD[@]+"${FORWARD[@]}"}
BENCH_STATUS=$?
set -e

if ((BENCH_STATUS != 0)); then
  fail "benchmark exited with status $BENCH_STATUS"
  exit "$BENCH_STATUS"
fi

if [[ -n "$JSON_OUT" ]]; then
  if [[ -f "$JSON_OUT" ]]; then
    ok "results written to $JSON_OUT"
  elif [[ -f "$LVF_REPO_ROOT$JSON_OUT" ]]; then
    # join(repoRoot, absolutePath) in benchmark.ts lands the file here instead.
    warn "benchmark.js wrote $LVF_REPO_ROOT$JSON_OUT instead of $JSON_OUT"
    hint "It resolves --json against the repository root; pass a relative path, or fix the join() there"
  else
    warn "benchmark.js did not create $JSON_OUT"
    hint "Check that apps/core/dist/benchmark.js understands --json=<file>"
  fi
fi

exit 0
