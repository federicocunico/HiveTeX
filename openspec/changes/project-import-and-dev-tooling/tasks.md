# Tasks

## 1. Import core (pure, unit-tested)

- [x] 1.1 Create `apps/web/src/lib/import/` with `classify.ts` (text/binary rules moved from `session.addFile`, extended extension list, UTF-8 fatal decode → Windows-1252 fallback with `converted` flag, BOM strip); verify Vitest cases for mixed content, Latin-1 "perché", BOM and NUL-in-`.tex` pass
- [x] 1.2 Add `filter.ts` reusing `DEFAULT_IGNORES` from `@p2platex/sync` plus import-only junk (`__MACOSX/`, `Thumbs.db`, `.svn/`) and shared path-safety checks (absolute, drive letter, `..`, backslash normalization); verify tests for traversal, build artifacts (`.aux`/`.log`/`.synctex.gz` skipped with reason) and junk
- [x] 1.3 Move zip reading to `import/zip.ts` with entry-count cap (5 000) and corrupt-archive rethrow, plus common-top-level-folder stripping; verify existing behaviors still pass and new tests for count cap, truncated zip and `paper-main/` stripping
- [x] 1.4 Implement `import/tar.ts` (ustar + PAX long names, streaming `fflate.Gunzip` with running size cap, only regular files/dirs allowed); verify tests with a generated `.tar.gz` (arXiv-like), symlink entry rejected, hardlink rejected, truncated block, gzip bomb aborting early
- [x] 1.5 Implement `import/detect.ts` (main-file order: `% !TEX root`, `main.tex`, top-level `\documentclass`+`\begin{document}`, any such file; engine from `% !TEX program` or `fontspec`/`unicode-math`/`polyglossia`; comment-aware); verify tests for `paper.tex` vs `sections/intro.tex`, magic comments, commented-out `\usepackage{fontspec}` ignored, ambiguity flag with two root documents
- [x] 1.6 Implement `import/plan.ts` producing added/changed/identical/skipped/converted (+ deleted for replace) against current project files, and `import/sources.ts` uniform entry iterator for archive `File`, `FileList`, and DataTransfer directory entries; verify planner tests for each category and replace mode, and a sources test using a fake `FileSystemDirectoryEntry`
- [x] 1.7 Remove `apps/web/src/lib/zip.ts` import/detect code (keep `exportZip`, relocated if needed) and update imports; verify `pnpm turbo build lint test` and `svelte-check` pass

## 2. Coherent apply in sync model

- [x] 2.1 Export `DEFAULT_IGNORES` from `@p2platex/sync` index if not already public; verify web package compiles importing it
- [x] 2.2 Add `ProjectModel.applyBatch(ops)` in `packages/sync/src/model.ts` (create text with initial content, create binary, delete, set settings in one root transaction; text overwrite via `applyTextDiff`); verify `packages/sync` tests: a second peer receives one index update containing all files, existing text file keeps its id after overwrite, deletes applied
- [x] 2.3 Implement `import/apply.ts` (blobs first, then `applyBatch`, progress callback) and make `session.addFile` delegate to `classify`; verify unit test with an in-memory session/model that a failing blob read before apply leaves the model unchanged

## 3. Import UI (web + desktop)

- [x] 3.1 Build `ImportDialog.svelte` (grouped lists with counts, per-file overwrite/keep, overwrite-all/keep-all, replace-project with second-click confirm, main-file picker, progress bar, final summary with expandable skipped reasons; focus trap, keyboard operable); verify via e2e in 3.5 and axe check in `e2e/a11y.spec.ts`
- [x] 3.2 Update `Projects.svelte` creation form to accept an archive (`.zip,.tar,.tar.gz,.tgz`) or a folder (`webkitdirectory`), hand a parsed bundle to the workspace, skip the preview for empty projects unless main detection is ambiguous; verify e2e "create from Overleaf-style zip" sets detected main and engine
- [x] 3.3 Add "Import…" action in the workspace header (editors only) and wire `FileTree` drop to walk directories via `webkitGetAsEntry`, routing all uploads/drops through the pipeline; replace the `confirm()` for dropped archives with Extract / Add-as-file choice; verify e2e: upload of existing `figure.png` asks before overwrite, viewer sees no import/upload controls
- [ ] 3.4 Desktop: folder import via `@tauri-apps/plugin-dialog` + `tauri-fs.ts` recursive read (add a scoped Tauri command reusing mirror ignore logic only if the existing helpers cannot read a tree); verify manually with `make desktop-dev` importing a folder and with `cargo test --lib` if a command is added
- [x] 3.5 Add `e2e/import.spec.ts` covering: Overleaf zip create, arXiv tar.gz into existing project with conflict keep-existing, replace-all, traversal zip rejected with no change, oversized file rejected while others imported, Latin-1 file converted notice, co-author sees all imported files; verify `pnpm exec playwright test e2e/import.spec.ts` passes
- [x] 3.6 Document import (supported formats, limits, filtering, encoding, conflict options, Overleaf/arXiv how-to) in `docs/import.md` and link it from README; verify links resolve and the docs test in `packages/protocol/test/docs.test.ts` (if it checks links) passes

## 4. Server overrides for local emulators

- [x] 4.1 Make `createNeonDb` honor `NEON_HTTP_ENDPOINT` (sets `neonConfig.fetchEndpoint`/ws options only when set); verify unit test that config is untouched when unset
- [x] 4.2 Add `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` override to the mailer, Gmail path unchanged when unset; verify unit test selecting the transport for both cases
- [x] 4.3 Refactor `production.ts` into `productionDepsWith({ upgradeWebSocket, background })` keeping the Vercel entry behavior identical, and add `server/src/docker.ts` (node server + ws upgrade like `local.ts`, ephemeral ticket key only when `P2PLATEX_DEV_STACK=1`, migrations on start); verify `pnpm --filter @p2platex/server build test` passes and `api/index.ts` still type-checks

## 5. Docker Compose stack

- [x] 5.1 Read installed turbo docs per AGENTS.md, then add `docker/api.Dockerfile`, `docker/web.Dockerfile` (static server with `/api` + websocket proxy and `vercel.json`-equivalent security headers), `docker/.env.stack` with dev-only defaults, and `.dockerignore`; verify `docker compose build` succeeds
- [x] 5.2 Write `docker-compose.yml` with postgres, neon-proxy, redis, upstash (SRH + pub/sub shim), mailpit, api, web (pinned image versions, healthchecks, named volumes) and profiles `turn` (coturn) and `texlive` (nginx + `VITE_TEXLIVE_URL` build arg); verify `docker compose up -d --wait` then `curl localhost:3001/api/health` → 200, `localhost:8080` serves the app, `localhost:8025` shows Mailpit
- [x] 5.3 Verify production-path parity manually: register in the stack web app, confirm the user row in Postgres (`docker compose exec postgres psql`), rate-limit keys in Redis, verification mail in Mailpit, and two browser tabs connect over `/api/signal`
- [x] 5.4 Write `docs/local-stack.md` (services, ports, profiles, reset, troubleshooting on Windows/WSL2) and link from README; verify a fresh clone follows it to a running stack

## 6. Makefile

- [x] 6.1 Create root `Makefile` (`SHELL := bash`, `.PHONY`, self-documenting `help` default target, `require-%` tool checks with install hints) with targets `install`, `dev`, `build`, `lint`, `typecheck`, `test`, `e2e`, `check`, `desktop-dev`, `desktop-test`, `desktop-build`, `clean`; verify `make` prints help only and `make check` runs the CI-equivalent sequence and fails when a test fails
- [x] 6.2 Add stack targets `up`/`down`/`logs`/`ps`/`reset` (with `PROFILES=`), `migrate-local`, and `test-stack`; extend `playwright.config.ts` with `PLAYWRIGHT_BASE_URL`/`SKIP_WEBSERVER` and `e2e/helpers.ts` with a Mailpit mailbox adapter; verify `make test-stack` runs the e2e suite against the stack and `make up` without Docker prints the install hint
- [x] 6.3 Add Vercel targets `env-pull`, `deploy-preview`, `deploy-prod` (requires `CONFIRM=1`, runs `check` first), `migrate-prod`, `seed-admin ADMIN=…` using `npx vercel@latest` and a link check (`.vercel/project.json`); verify `make deploy-prod` without `CONFIRM=1` exits without deploying and an unlinked checkout gets the `vercel link` hint
- [x] 6.4 Update README "Development" and `docs/deployment.md` to use Make targets (with Windows `make` install note and the plain `pnpm` equivalents); verify every command in those docs exists in `make help`
- [ ] 6.5 Verify Makefile on Windows Git Bash and in CI (add a `make check` step or keep the existing steps and add `make help` smoke check in `.github/workflows/ci.yml`); verify CI passes on a pushed branch

## 7. Integration

- [ ] 7.1 End-to-end check on the Docker stack: `make reset && make up && make test-stack` passes including `e2e/import.spec.ts`; then `make deploy-preview` and import a real Overleaf zip and an arXiv tarball on the preview, confirming a second client sees the files and the PDF compiles

## Workflow follow-up

- Run `/opsx:apply` to implement, then archive the change after review (ideally after `bootstrap-p2p-latex-platform` is archived so `latex-workspace` exists in `openspec/specs/`).
