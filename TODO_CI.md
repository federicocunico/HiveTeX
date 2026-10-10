# CI/CD: what is missing

Status after investigating the failed run [`CI` #37941941428](https://github.com/federicocunico/p2platex/actions/runs/37941941428)
(commit `411377b`). As of run [#37947085763](https://github.com/federicocunico/p2platex/actions/runs/37947085763) **CI and Desktop are green**
(`full-flow.spec.ts` still needed one retry).

## Fixed in this commit

| Problem | Cause | Fix |
|---|---|---|
| `CI / test` failed at *Lint, type-check and unit tests* | `@p2platex/compile` › `pipeline.test.ts` › "compiles … on the leader only" expected 0 compiles on a non-leader and got 1. The test used a 50 ms election heartbeat, so a peer counted as gone after 150 ms. On the 2-vCPU runner, with turbo running every package's tests in parallel, a short event-loop stall made a non-leader elect itself and compile once. Production uses 2 s × 3 beats plus a 1.5 s settle, so the app was not affected. | Test timing raised to a 100 ms heartbeat (300 ms timeout) and a 400 ms settle. Passes 4 parallel copies locally and a full Linux reproduction of the CI job. |
| `CI / test` failed again: `server` › `projects.test.ts` "Hook timed out in 10000ms" | Every server test boots an in-memory PGlite database and applies the migrations in `beforeEach` (about 1.5 s locally, over 10 s on the loaded runner) | `server/vitest.config.ts`: 60 s hook and test timeouts |
| `CI / e2e` failed: "layout … at phone width" | At 390 px the header (username + "Sign out") overflowed whenever the random test username was long enough, so the test was flaky | Header wraps and truncates long usernames (`app.css`); the test now always uses a 28-char username (fails without the fix, passes with it) |
| `CI / e2e` `full-flow.spec.ts` timed out (4 min) waiting for the joined peer to receive the file tree | Intermittent WebRTC connection set-up between three browsers on a 2-vCPU runner (known flakiness, see below) | CI retries flaky e2e tests up to 2 times (still reported as flaky) and `actionTimeout` is 30 s so a stuck step fails fast |
| `Desktop / rust-tests (windows)` failed: `tex::tests::compiles_a_sample_document` with an empty log | A fresh MiKTeX from Chocolatey has no package database and no auto-install, so the engine exits before writing a log | Workflow configures MiKTeX (AutoInstall, package database, fndb), and *Detect TeX* now compiles a sample with `pdflatex` and `latexmk` and prints the output |
| `Desktop` workflow never ran | It triggers on pushes to `main`, but the repository branch is `master` | Triggers on `[main, master]` |
| `LICENSE` missing | README and package.json declare AGPL-3.0-or-later but the file was absent | Added the official AGPL-3.0 text (bootstrap task 1.4) |

The rest of the CI job was reproduced on Linux before pushing, in the Playwright `v1.64.0-noble` image with the same
steps as `ci.yml`. It all passes: install, Makefile smoke test, turbo build/lint/test, svelte-check, bundle budget
(217 / 250 KB), audit (1 moderate, below the `high` threshold) and all 16 e2e tests.

## Still missing (needs you: accounts, secrets or decisions)

### Secrets and variables (Settings → Secrets and variables → Actions)
- [ ] `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Required by the `release` job (tags `v*`) to sign
      updater artifacts. Generate the key with `pnpm --filter @p2platex/desktop tauri signer generate`. The **public**
      key in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) must match it; replace the committed
      one if you generate a new pair.
- [ ] Optional macOS signing/notarization: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
      `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them, installers are unsigned and Gatekeeper warns.
- [ ] Optional Windows code signing (not wired yet). Without it, SmartScreen warns on first install.
- [ ] Repository variable `P2PLATEX_API_BASE` (the deployed control-plane URL). Release builds bake it in as
      `VITE_API_BASE`.

### Deployment (no workflow exists yet)
- [ ] Link the repo to Vercel (`npx vercel@latest link`, or import it in the Vercel dashboard). The Git integration then
      builds a preview per push and production on `master`, with no workflow needed. Alternatively add a deploy job with
      `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.
- [ ] Provision Neon + Upstash from the Vercel Marketplace and set the remaining env vars from `.env.example`
      (`TICKET_*`, `GMAIL_*`, optional `GITHUB_APP_*`, `CF_TURN_*`).
- [ ] Run migrations on each deploy: `make migrate-prod` after `make env-pull`, or a CI step with `DATABASE_URL` as a
      secret.

### Workflow hygiene
- [x] Actions moved to their Node 24 majors (`checkout@v5`, `setup-node@v5`, `pnpm/action-setup@v5`,
      `upload-artifact@v6`; `rust-cache@v2` and `tauri-action@v0` already run on Node 24). Done in `local-folder-projects`.
- [x] `make test-stack` runs nightly and on demand: `.github/workflows/stack-nightly.yml` (Actions → Stack (nightly) → Run
      workflow). It became reliable once the signaling reconnect race below was fixed.
- [x] Desktop UI tests: `Desktop / desktop-e2e` drives the real app over WebDriver (`tauri-driver`) on Linux (xvfb +
      WebKitWebDriver) and Windows (msedgedriver matched to the runner's WebView2). Locally: `make desktop-e2e`.
      The Windows leg is `continue-on-error` because hosted runners sometimes update WebView2 before the matching
      driver is published; Linux gates the workflow. Revisit once a few weeks of runs show it stable.
- [ ] Decide on the default branch name (`master` vs `main`). The workflows accept both, but docs and tooling assume
      `main`.

### Unverified until the workflows run on GitHub
- [x] `Desktop / rust-tests` on macOS (BasicTeX) and Ubuntu (TeX Live) pass, including real LaTeX compilation.
- [x] `Desktop / rust-tests` on Windows (MiKTeX via Chocolatey) pass after the MiKTeX setup fix, and `Desktop / e2e-sync` passes.
- [ ] `Desktop / release` on a `v*` tag: needs the signing secrets above.

### Known product issues that affect CI stability
- [x] `packages/sync` › `mirror.test.ts` flakes were two real races, fixed in `realtime-sync-and-desktop-fixes`: a file caught
      mid-rewrite was imported as "all deleted" (reordering a co-author's edit), and an in-flight write resurrected a file
      under its old name after a rename. The suite passes 24/24 under 3x parallel load.
- [x] Same-device reconnect race in signaling (an old session's delayed cleanup dropped the reloaded device's new
      connection): fixed with per-connection session ids (presence `sid|ticket`, compare-and-delete, `sid` on join/leave,
      clients ignore stale leaves), plus a stale-link deadlock in `ConnectionManager` and a test bug when the editor
      was the leader (see `local-folder-projects` design D9). `e2e/full-flow.spec.ts` passed 10 consecutive runs on the dev
      server and 10 on the Docker stack.
- [x] `e2e/realtime.spec.ts` (seven browsers) sometimes never reached a full mesh ("3 peers online"): signals relayed
      through the mesh went to a peer that was not linked to the target and were dropped. Fixed by routing through a
      peer that announced a link to the target (see `local-folder-projects` design D9); 3/3 on the Docker stack.
- [ ] Linux desktop without a Secret Service (no gnome-keyring/KWallet, e.g. a bare window manager): device keys cannot be
      stored, so the device never registers and projects open read-only with 0 peers, without a clear message. CI
      provides an unlocked gnome-keyring for `desktop-e2e`. Product follow-up: show an explicit "no keychain" error.
- [ ] The public SwiftLaTeX TeX file server (`texlive2.swiftlatex.com`) was answering HTTP 522 on 2026-10-09. CI is
      not affected because e2e uses the fake engine, but in-browser compilation in production depends on it. Consider
      self-hosting (`make up PROFILES=texlive`, see `docs/local-stack.md`).

## Security-hardening tasks left open at archive time

- [x] 4.2 (manual `make desktop-dev` check of "Link folder" + folder import through `mirror_pick`): now automated by
      `make desktop-e2e` / `Desktop / desktop-e2e` (link a folder, open a marker folder, create from a folder, import a
      folder, external edits).

## Bootstrap tasks left open at archive time

Archived as `openspec/changes/archive/2026-10-09-bootstrap-p2p-latex-platform/` with these tasks still open. They all
need accounts, secrets or time that CI cannot provide:

- [ ] 1.3: run `vercel build` / `vercel dev` locally to verify the static + function output and the headers (needs `vercel login` + `vercel link`).
- [ ] 2.1: provision Neon and Upstash via the Vercel Marketplace, then check `vercel env pull`.
- [ ] 3.4: send a manual smoke email through Gmail SMTP with real credentials (the code and the test double are done).
- [ ] 8.5: real in-browser compile with SwiftLaTeX in Playwright. The public TeX server returned HTTP 522; e2e uses the fake
      engine. Persisting downloaded packages in Cache Storage is also still open.
- [ ] 9.5: signed release builds via tag `v*` (needs the signing secrets above).
- [ ] 10.7: check the GitHub App setup in `docs/github-backup.md` against a freshly created App.
- [ ] 11.1: full e2e on a Vercel preview (2 web clients + 1 desktop).
- [ ] 11.3: measure free-tier usage over a 1-week beta.
- [ ] 11.4: seed the production admin, promote to production, publish a desktop release, run a production smoke test.
