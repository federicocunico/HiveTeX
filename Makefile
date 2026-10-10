# p2platex developer commands. Run `make` (or `make help`) for the list.
# Requires GNU Make (3.81+). On Windows run it from Git Bash; install with `scoop install make` or `choco install make`.
# Every target is a thin wrapper: the equivalent pnpm / docker / vercel command is shown in the recipe.

SHELL := bash
.DEFAULT_GOAL := help

PNPM    ?= pnpm
VERCEL  ?= npx --yes vercel@latest
COMPOSE ?= docker compose
WEB_PORT ?= 8080
PROFILES ?=
comma := ,
PROFILE_FLAGS := $(foreach p,$(subst $(comma), ,$(PROFILES)),--profile $(p))
S ?=

# Install hints shown by `require-<tool>`.
HINT_pnpm   := install Node 22 and run: corepack enable  (https://pnpm.io/installation)
HINT_docker := install Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux): https://docs.docker.com/get-docker/
HINT_cargo  := install Rust: https://rustup.rs
HINT_npx    := install Node 22: https://nodejs.org
HINT_node   := install Node 22: https://nodejs.org
HINT_git    := install Git: https://git-scm.com/downloads

.PHONY: help install dev build lint typecheck test size e2e bench check audit clean \
        desktop-dev desktop-test desktop-e2e desktop-build \
        up down ps logs reset migrate-local test-stack secrets version release \
        env-pull deploy-preview deploy-prod migrate-prod seed-admin \
        require-vercel-link

## ---------- Development ----------

help: ## Show this help
	@echo "p2platex make targets:"
	@grep -E '^(## |[a-zA-Z0-9_-]+:.*## )' $(MAKEFILE_LIST) | sed -e 's/^## \(.*\)/\n\1/' -e 's/^\([a-zA-Z0-9_-]*\):.*## \(.*\)/  \1|\2/' | awk -F'|' 'NF==2 { printf "  %-16s %s\n", substr($$1,3), $$2; next } { print }'
	@echo ""
	@echo "Variables: PROFILES=turn,texlive (stack)  S=<service> (logs)  ADMIN=<username> (seed-admin)  CONFIRM=1 (deploy-prod)"

install: require-pnpm ## Install all workspace dependencies (pnpm install)
	$(PNPM) install

dev: require-pnpm ## Run the API (embedded DB, :3000) and web app (:1420) with hot reload
	$(PNPM) turbo run dev --filter=@p2platex/server --filter=@p2platex/web

build: require-pnpm ## Build / type-check every package (turbo build)
	$(PNPM) turbo run build

lint: require-pnpm ## Lint every package (biome via turbo)
	$(PNPM) turbo run lint

typecheck: require-pnpm ## Svelte type-check of the web app
	$(PNPM) --filter @p2platex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error

test: require-pnpm ## Unit and integration tests of every package (turbo test)
	$(PNPM) turbo run test

size: require-pnpm ## Check the web bundle budget
	$(PNPM) --filter @p2platex/web build
	$(PNPM) --filter @p2platex/web size

e2e: require-pnpm ## End-to-end tests (starts the embedded-DB API and Vite automatically)
	$(PNPM) exec playwright install chromium
	$(PNPM) exec playwright test

bench: require-pnpm ## Sync benchmark: keystroke latency, messages per edit, convergence for 2-16 peers (LATENCY_MS=20)
	$(PNPM) --filter @p2platex/sync bench

check: build lint typecheck test size e2e ## Everything CI runs except the dependency audit; fails on the first error

audit: require-pnpm ## Dependency audit (high severity)
	$(PNPM) audit --audit-level=high

clean: ## Remove build outputs and test artifacts (keeps node_modules and local data)
	rm -rf apps/web/dist .turbo apps/*/.turbo packages/*/.turbo server/.turbo test-results playwright-report

## ---------- Desktop (Tauri, runs on the host) ----------

desktop-dev: require-pnpm require-cargo ## Run the desktop app in dev mode
	$(PNPM) --filter @p2platex/desktop tauri dev

desktop-test: require-cargo ## Rust tests of the desktop shell
	cd apps/desktop/src-tauri && cargo test --lib && cargo build --examples

desktop-e2e: require-pnpm require-cargo ## Desktop UI tests: debug app (test-picker) + tauri-driver + WebDriver (see docs/folders.md)
	$(PNPM) --filter @p2platex/desktop e2e

desktop-build: require-pnpm require-cargo ## Build desktop installers for this OS
	$(PNPM) --filter @p2platex/desktop tauri build

## ---------- Local stack (Docker, production code path; see docs/local-stack.md) ----------

up: require-docker ## Build and start the full stack (web :8080, mail :8025); PROFILES=turn,texlive for extras
	$(COMPOSE) $(PROFILE_FLAGS) up -d --build --wait --remove-orphans
	@echo ""
	@echo "  web      http://localhost:$(WEB_PORT)"
	@echo "  mailbox  http://localhost:8025"
	@echo "  api      http://localhost:3001/api/health"

down: require-docker ## Stop the stack (data is kept)
	$(COMPOSE) $(PROFILE_FLAGS) down

ps: require-docker ## Show stack status
	$(COMPOSE) ps

logs: require-docker ## Follow stack logs (S=api for one service)
	$(COMPOSE) logs -f $(S)

reset: require-docker ## Stop the stack and DELETE its database and Redis volumes
	$(COMPOSE) $(PROFILE_FLAGS) down -v --remove-orphans

migrate-local: require-pnpm ## Apply migrations to the stack database from the host
	DATABASE_URL=postgres://postgres:postgres@db.localtest.me:5432/main NEON_HTTP_ENDPOINT=http://localhost:4444/sql \
		$(PNPM) --filter @p2platex/server migrate

test-stack: require-docker require-pnpm ## Run the e2e suite against the stack (rate limits off while it runs)
	E2E_NO_LIMITS=1 $(COMPOSE) up -d --build --wait --remove-orphans
	$(PNPM) exec playwright install chromium
	PLAYWRIGHT_BASE_URL=http://localhost:$(WEB_PORT) SKIP_WEBSERVER=1 $(PNPM) exec playwright test

## ---------- Vercel (control plane + web; see docs/deployment.md) ----------

env-pull: require-npx require-vercel-link ## Pull the linked project's env vars into .env.local
	$(VERCEL) env pull .env.local

deploy-preview: require-npx require-vercel-link ## Deploy a preview and print its URL
	$(VERCEL) deploy

deploy-prod: require-npx require-vercel-link ## Run `make check`, then deploy to production (needs CONFIRM=1)
	@if [ "$(CONFIRM)" != "1" ]; then \
		echo "Refusing to deploy to production without confirmation."; \
		echo "Run: make deploy-prod CONFIRM=1   (runs 'make check' first)"; \
		exit 1; \
	fi
	$(MAKE) check
	$(VERCEL) deploy --prod

migrate-prod: require-pnpm ## Apply migrations to the database in .env.local (run `make env-pull` first)
	@test -f .env.local || { echo ".env.local not found: run 'make env-pull' first."; exit 1; }
	cd server && node --env-file=../.env.local --import tsx scripts/migrate.ts

seed-admin: require-pnpm ## Make ADMIN=<username> a platform admin in the .env.local database
	@test -n "$(ADMIN)" || { echo "Usage: make seed-admin ADMIN=<username>"; exit 1; }
	@test -f .env.local || { echo ".env.local not found: run 'make env-pull' first."; exit 1; }
	cd server && node --env-file=../.env.local --import tsx scripts/seed-admin.ts $(ADMIN)

## ---------- Release (desktop installers on GitHub; see README "Release v0.1") ----------

secrets: require-node ## Print fresh server secrets and the vercel/gh commands to store them (writes no files)
	node scripts/gen-secrets.mjs

version: require-node ## Set the version everywhere: make version VERSION=0.1.0
	@test -n "$(VERSION)" || { echo "Usage: make version VERSION=x.y.z"; exit 1; }
	node scripts/set-version.mjs $(VERSION)

release: require-git require-node ## Tag and push vVERSION, which builds a draft GitHub Release (needs CONFIRM=1)
	@test -n "$(VERSION)" || { echo "Usage: make release VERSION=x.y.z CONFIRM=1"; exit 1; }
	@v=$$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version"); \
	if [ "$$v" != "$(VERSION)" ]; then echo "Sources are at $$v, not $(VERSION): run 'make version VERSION=$(VERSION)' and commit first."; exit 1; fi
	@test -z "$$(git status --porcelain)" || { echo "Commit or stash your changes first (the tag must match a pushed commit)."; exit 1; }
	@if [ "$(CONFIRM)" != "1" ]; then \
		echo "This would run:"; echo "  git tag v$(VERSION) && git push origin HEAD v$(VERSION)"; \
		echo "Re-run with CONFIRM=1 to do it."; exit 1; \
	fi
	git tag v$(VERSION)
	git push origin HEAD v$(VERSION)

# ---------- Helpers ----------

require-%:
	@command -v $* >/dev/null 2>&1 || { echo "error: '$*' is required but was not found."; echo "  $(HINT_$*)"; exit 1; }

require-vercel-link:
	@test -f .vercel/project.json || { echo "This checkout is not linked to a Vercel project."; echo "Run: npx vercel@latest link   (then 'make env-pull')"; exit 1; }
