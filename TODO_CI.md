# CI/CD: what is missing

Status after investigating the failed run [`CI` #37941941428](https://github.com/federicocunico/p2platex/actions/runs/37941941428)
(commit `411377b`, branch `master`).

## Fixed in this commit

| Problem | Cause | Fix |
|---|---|---|
| `CI / test` failed at *Lint, type-check and unit tests* | `@p2platex/compile` › `pipeline.test.ts` › "compiles … on the leader only" expected 0 compiles on a non-leader and got 1. The test used a 50 ms election heartbeat, so a peer counted as gone after 150 ms. On the 2-vCPU runner, with turbo running every package's tests in parallel, a short event-loop stall made a non-leader elect itself and compile once. Production uses 2 s × 3 beats plus a 1.5 s settle, so the app was not affected. | Test timing raised to a 100 ms heartbeat (300 ms timeout) and a 400 ms settle. Passes 4 parallel copies locally and a full Linux reproduction of the CI job. |
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
- [ ] GitHub warns that `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` and
      `pnpm/action-setup@v4` target the deprecated Node 20 runtime. Bump them to their Node 24 majors once you have
      checked the release notes. Today this is a warning, not a failure.
- [ ] Nightly or manual job for `make test-stack` (the Docker stack with production wiring). Not added on purpose: it
      takes about 8 minutes, and `e2e/full-flow.spec.ts` is flaky on the stack until the known signaling issue below is
      fixed.
- [ ] Decide on the default branch name (`master` vs `main`). The workflows accept both, but docs and tooling assume
      `main`.

### Unverified until the workflows run on GitHub
- [ ] `Desktop / rust-tests` on Windows (MiKTeX via Chocolatey), macOS (BasicTeX) and Ubuntu (TeX Live). It has never
      run, because of the branch trigger fixed above. The TeX install steps are the most likely to need adjusting
      (MiKTeX path, first-run package installs).
- [ ] `Desktop / release` on a `v*` tag: needs the signing secrets above.

### Known product issues that affect CI stability
- [ ] Same-device reconnect race in signaling: after a page reload, the old session's delayed cleanup can drop the new
      connection. It makes `e2e/full-flow.spec.ts` occasionally fail on line 90, rarely on the dev server and more often
      on the Docker stack. Fix: per-connection session ids in the signaling protocol (see
      `openspec/changes/archive/2026-10-09-project-import-and-dev-tooling/design.md`, D11).
- [ ] The public SwiftLaTeX TeX file server (`texlive2.swiftlatex.com`) was answering HTTP 522 on 2026-10-09. CI is
      not affected because e2e uses the fake engine, but in-browser compilation in production depends on it. Consider
      self-hosting (`make up PROFILES=texlive`, see `docs/local-stack.md`).
