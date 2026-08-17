# LocalVoiceFlow — every task is a thin wrapper around scripts/, so nothing here
# is make-only knowledge. Run `make` (or `make help`) for the list.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
LIB := $(REPO)/scripts/_lib.sh

# Extra arguments for the wrapped script, e.g. `make benchmark ARGS="--runs=5"`.
ARGS ?=

.PHONY: help bootstrap dev build install start stop restart doctor test fixtures benchmark \
        uninstall uninstall-purge smoke-claude smoke-openai fmt clean

help: ## Show this help
	@bold=""; dim=""; reset=""; \
	if [ -t 1 ] && [ -z "$${NO_COLOR:-}" ]; then \
	  bold=$$(printf '\033[1m'); dim=$$(printf '\033[2m'); reset=$$(printf '\033[0m'); \
	fi; \
	printf '%sLocalVoiceFlow%s — local dictation for macOS (Apple Silicon)\n\n' "$$bold" "$$reset"; \
	awk -v bold="$$bold" -v reset="$$reset" 'BEGIN { FS = ":.*## " } \
	  /^[a-zA-Z0-9_-]+:.*## / { printf "  %s%-16s%s %s\n", bold, $$1, reset, $$2 }' \
	  $(lastword $(MAKEFILE_LIST)); \
	printf '\n%sargs:%s  make benchmark ARGS="--provider=claude-cli --runs=3 --json out.json"\n' "$$dim" "$$reset"; \
	printf '%sport:%s  LVF_PORT=43118 make start\n' "$$dim" "$$reset"; \
	printf '%sdata:%s  ~/Library/Application Support/LocalVoiceFlow    logs: ~/Library/Logs/LocalVoiceFlow\n' "$$dim" "$$reset"

bootstrap: ## Check the toolchain, install deps, create the Python venv
	@"$(REPO)/scripts/bootstrap.sh" $(ARGS)

dev: ## Run core (watch) and the vite dev server together
	@source "$(LIB)"; \
	step "core --watch + vite dev — Ctrl-C stops both"; \
	set -m; \
	pids=""; \
	cleanup() { for p in $$pids; do kill -TERM -"$$p" 2>/dev/null || kill -TERM "$$p" 2>/dev/null || true; done; }; \
	trap cleanup EXIT INT TERM; \
	( cd "$(REPO)" && pnpm --filter @lvf/core dev ) & pids="$$pids $$!"; \
	( cd "$(REPO)" && pnpm --filter @lvf/web dev ) & pids="$$pids $$!"; \
	wait || true

build: ## Build shared, web, core, the Swift agent and the .app bundle
	@"$(REPO)/scripts/build.sh" $(ARGS)

install: ## Build, install the LaunchAgent, open the dashboard (no sudo)
	@"$(REPO)/scripts/install.sh" $(ARGS)

start: ## Start core and the menu-bar agent
	@"$(REPO)/scripts/start.sh" $(ARGS)

stop: ## Stop core and the menu-bar agent
	@"$(REPO)/scripts/stop.sh" $(ARGS)

restart: ## Restart core and the menu-bar agent
	@"$(REPO)/scripts/restart.sh" $(ARGS)

doctor: ## Diagnose permissions, core, STT and both LLM CLIs
	@"$(REPO)/scripts/doctor.sh" $(ARGS)

test: ## Run the TypeScript, Swift and Python test suites
	@source "$(LIB)"; \
	failures=0; \
	step "TypeScript — pnpm -r test"; \
	if ( cd "$(REPO)" && pnpm -r test ); then ok "pnpm tests passed"; \
	else fail "pnpm tests failed"; failures=$$((failures + 1)); fi; \
	step "Swift — apps/mac-agent"; \
	if [ -f "$(REPO)/apps/mac-agent/Package.swift" ]; then \
	  if ( cd "$(REPO)/apps/mac-agent" && swift test ); then ok "swift tests passed"; \
	  else fail "swift tests failed"; failures=$$((failures + 1)); fi; \
	else warn "apps/mac-agent/Package.swift not found — skipped"; \
	  hint "Nothing to run until the Swift agent lands in the tree"; fi; \
	step "Python — services/stt-worker"; \
	if [ -x "$(REPO)/services/stt-worker/.venv/bin/python" ]; then \
	  start_dir="."; \
	  if [ -d "$(REPO)/services/stt-worker/tests" ]; then start_dir="tests"; fi; \
	  if ( cd "$(REPO)/services/stt-worker" && \
	       PYTHONPATH="$(REPO)/services/stt-worker" \
	       .venv/bin/python -m unittest discover -v -s "$$start_dir" -t "$$start_dir" -p "test_*.py" ); then \
	    ok "python tests passed"; \
	  else fail "python tests failed"; failures=$$((failures + 1)); fi; \
	else warn "services/stt-worker/.venv not found — skipped"; \
	  hint "Create it with: make bootstrap"; fi; \
	printf '\n'; \
	if [ "$$failures" -gt 0 ]; then fail "$$failures suite(s) failed"; exit 1; fi; \
	ok "all suites that could run passed"

fixtures: ## Regenerate the benchmark audio fixtures (macOS `say` + ffmpeg)
	@"$(REPO)/scripts/fixtures.sh"

benchmark: ## Measure STT and LLM latency (ARGS="--skip-llm" spends no quota)
	@"$(REPO)/scripts/benchmark.sh" $(ARGS)

uninstall: ## Remove the LaunchAgent and the .app, keep user data
	@"$(REPO)/scripts/uninstall.sh" $(ARGS)

uninstall-purge: ## Remove everything, including history, audio and logs
	@"$(REPO)/scripts/uninstall.sh" --purge $(ARGS)

smoke-claude: ## Real Claude CLI round-trip — SPENDS SUBSCRIPTION QUOTA
	@source "$(LIB)"; \
	printf '%s\n' "$$LVF_C_YELLOW=============================================================$$LVF_C_RESET"; \
	printf '%s\n' "$$LVF_C_BOLD  WARNING: this runs a REAL request through the claude CLI.$$LVF_C_RESET"; \
	printf '%s\n' "  It consumes your paid Claude subscription quota."; \
	printf '%s\n' "  Ctrl-C within 3 seconds to abort."; \
	printf '%s\n' "$$LVF_C_YELLOW=============================================================$$LVF_C_RESET"; \
	sleep 3; \
	if [ ! -f "$(REPO)/apps/core/dist/smoke.js" ]; then \
	  fail "apps/core/dist/smoke.js not found"; hint "Build core first: make build"; exit 2; fi; \
	cd "$(REPO)" && node apps/core/dist/smoke.js --provider=claude-cli $(ARGS)

smoke-openai: ## Real Codex CLI round-trip — SPENDS SUBSCRIPTION QUOTA
	@source "$(LIB)"; \
	printf '%s\n' "$$LVF_C_YELLOW=============================================================$$LVF_C_RESET"; \
	printf '%s\n' "$$LVF_C_BOLD  WARNING: this runs a REAL request through the codex CLI.$$LVF_C_RESET"; \
	printf '%s\n' "  It consumes your paid ChatGPT subscription quota."; \
	printf '%s\n' "  Ctrl-C within 3 seconds to abort."; \
	printf '%s\n' "$$LVF_C_YELLOW=============================================================$$LVF_C_RESET"; \
	sleep 3; \
	if [ ! -f "$(REPO)/apps/core/dist/smoke.js" ]; then \
	  fail "apps/core/dist/smoke.js not found"; hint "Build core first: make build"; exit 2; fi; \
	cd "$(REPO)" && node apps/core/dist/smoke.js --provider=openai-codex-cli $(ARGS)

fmt: ## Format TypeScript, Swift and Python where a formatter is available
	@source "$(LIB)"; \
	step "TypeScript / JSON / Markdown"; \
	if ! ( cd "$(REPO)" && pnpm exec prettier --version ) >/dev/null 2>&1; then \
	  warn "prettier is not installed in the workspace — skipped"; \
	  hint "Add it once: pnpm add -Dw prettier"; \
	elif ! ls "$(REPO)"/.prettierrc* "$(REPO)"/prettier.config.* >/dev/null 2>&1; then \
	  warn "no prettier config in the repo — skipped rather than reformatting everything to defaults"; \
	  hint "Add one first, e.g.: printf '%s\n' '{ \"printWidth\": 100 }' > .prettierrc.json"; \
	else \
	  ( cd "$(REPO)" && pnpm exec prettier --write \
	      "apps/*/src/**/*.{ts,tsx,css}" "packages/*/src/**/*.ts" "*.json" "docs/*.md" ) && \
	  ok "prettier finished"; \
	fi; \
	step "Swift"; \
	swift_format="$$(xcrun --find swift-format 2>/dev/null || true)"; \
	if [ -n "$$swift_format" ] && [ -d "$(REPO)/apps/mac-agent/Sources" ]; then \
	  "$$swift_format" format --in-place --recursive "$(REPO)/apps/mac-agent/Sources" && ok "swift-format finished"; \
	else warn "swift-format or apps/mac-agent/Sources not available — skipped"; fi; \
	step "Python"; \
	if [ -x "$(REPO)/services/stt-worker/.venv/bin/ruff" ]; then \
	  "$(REPO)/services/stt-worker/.venv/bin/ruff" format "$(REPO)/services/stt-worker" && ok "ruff finished"; \
	else warn "ruff is not in the STT venv — skipped"; \
	  hint "Add it once: services/stt-worker/.venv/bin/pip install ruff"; fi

clean: ## Delete build output (never touches user data)
	@source "$(LIB)"; \
	step "Removing build output"; \
	rm -rf "$(REPO)/packages/shared/dist" "$(REPO)/apps/core/dist" "$(REPO)/apps/web/dist" \
	       "$(REPO)/apps/mac-agent/.build"; \
	find "$(REPO)" -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete 2>/dev/null || true; \
	find "$(REPO)/services" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true; \
	ok "build output removed"; \
	note "User data was left alone: ~/Library/Application Support/LocalVoiceFlow"
