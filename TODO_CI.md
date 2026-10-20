# CI/CD: what is missing

Status on 2026-10-14 (0.8.0): **CI, Desktop and Deploy are green**. Pushes to master deploy production
through the Deploy workflow after CI passes (docs/deployment.md section 3). The fixes from the first CI bring-up
(timing in `pipeline.test.ts`, server hook timeouts, the phone-width header, the MiKTeX setup, the `master` trigger,
`LICENSE`) are in this file's git history.

## Fixed on 2026-10-14 (0.8.0)

- [x] `CI / browser-diagnostics`: `e2e/desktop-helper.spec.ts:51` failed on every run because the compile leader
      returned the browser's own result after pairing (a product bug: the desktop app never got the build); fixed in
      `CompileLeader.compilerSwitched()`. `e2e/a11y.spec.ts` and `e2e/folders.spec.ts` failed on a cold CI cache: Vite
      re-optimized dependencies mid-test (`504 Outdated Optimize Dep`, the editor never loaded); `optimizeDeps.entries`
      now scans every source at startup. Locally, with a cold cache and no retries: 81 passed, 0 failed.
- [x] Desktop Rust tests that failed in parallel (`maintenance::`, `texcache::`): they took the global compiler
      activity lock that compile tests hold; they now use a lock of their own.
- [x] `packages/sync` socket test and the doorbell representative test depended on timing; fixed (pongs answered; the
      representative rule tested directly on a three-device mesh).

## Open CI issues

- [ ] Make `CI / browser-diagnostics` blocking once it has stayed green for a while.
- [ ] `e2e/full-flow.spec.ts` may still need a retry on a 2-vCPU runner (WebRTC set-up between three browsers).
- [x] `server/test/application-relay-e2e.test.ts` "12 relay peers converge" failed once on CI: the start-up burst
      overflowed the relay router's per-recipient queue and fixed-timer retransmissions made it worse. Fixed by the
      relay congestion control (adaptive timeout, frame window, `relay_inbound_dropped`); the test runs without a retry,
      also with every relay delivery delayed by 15 ms.
- [ ] `apps/desktop/e2e/lifecycle.mjs` "worker started at login" timed out once (0e4d4ca, passed on rerun) with no app
      process at all: probably the previous, force-killed instance still held the single-instance lock, so the
      `--background` launch handed over to it and exited. Wait until no harness app is left before the login start.
- [x] `e2e/recovery.spec.ts` "Download version" saved an empty file in 3 of 8 local runs on 2026-10-19, only while
      uncommitted epoch work was in `packages/sync/src/mesh.ts`. Not reproduced on 2026-10-20 in more than 80 runs
      (7d9875f and 018f317, also 4–8 workers in parallel). Closed; reopen with a trace if it shows up on CI.
- [ ] Under heavy parallel load (8 workers) sign-up can miss its 15 s wait for "Your projects" (`e2e/helpers.ts`
      `newUser`). Not seen on CI.
- [ ] The two-machine sync checks are manual, not in CI: `make sandbox-sync` (this PC plus Windows Sandbox, fault
      injection `FAULT=deaf|deaf-silent|no-udp`, `MATRIX=...`) and `make rtc-lab` (browser and native WebRTC per ICE
      scenario; `HOLD_S=330 SCENARIOS=relay-udp PEERS=native` guards the TURN refresh patch). They need Windows Sandbox
      and run unattended (the sandbox setup allows the app in its firewall). The relay-first logic is covered in CI by
      `server/test/application-relay-e2e.test.ts` and the `packages/sync` lifecycle and probe tests.

## Secrets and variables (Settings → Secrets and variables → Actions)

- [x] `TAURI_SIGNING_PRIVATE_KEY` is set from `~/.tauri/hivetex.key` (empty password, matches the committed public key).
      Keep a backup of that file: without it, installed apps cannot verify future updates.
- [x] `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` (secrets) and
      `HIVETEX_API_BASE=https://hivetex.vercel.app` (variable; release builds bake it in as `VITE_API_BASE`).
- [ ] Optional macOS signing/notarization: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
      `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Without them, builds are ad-hoc signed: macOS asks once
      (*Open Anyway*).
- [ ] Optional Windows code signing (not wired yet). Without it, SmartScreen warns on first install.

## Deployment

- [x] The Deploy workflows (`deploy.yml`, `deploy-production.yml`) build a Git-source production deployment through the
      Vercel API after trusted CI succeeds, verify its SHA and health, then promote it. Vercel's own Git deploys stay
      disabled.
- [x] Neon and Upstash provisioned from the Vercel Marketplace; migrations run in the Vercel build.
- [x] Production env: tickets, Gmail, `BOOTSTRAP_ADMIN`, ExpressTURN (`TURN_*`) and the application relay
      (`APPLICATION_RELAY`, `RELAY_*`, `USAGE_LOG`, added 2026-10-14).
- [ ] Optional: `GITHUB_APP_*` (GitHub backup) and `CF_TURN_*` (second TURN provider) are not set.

## Workflow hygiene

- [x] Actions moved to their Node 24 majors (`checkout@v5`, `setup-node@v5`, `pnpm/action-setup@v5`,
      `upload-artifact@v6`; `rust-cache@v2` and `tauri-action@v0` already run on Node 24).
- [x] `make test-stack` runs nightly and on demand: `.github/workflows/stack-nightly.yml`.
- [x] Desktop UI tests: `Desktop / desktop-e2e` drives the real app over WebDriver on Linux and Windows
      (`make desktop-e2e` locally). The Windows leg stays `continue-on-error`: on `windows-2025`, WebView2 >= 133 never
      opens the DevTools port msedgedriver needs
      ([actions/runner-images#14738](https://github.com/actions/runner-images/issues/14738)); it passes on `windows-2022`.
- [ ] Decide on the default branch name (`master` vs `main`). The workflows accept both, but some docs and tooling
      assume `main`.

## Known product issues that affect CI stability

- [ ] Linux desktop without a Secret Service (no gnome-keyring/KWallet, e.g. a bare window manager): device keys cannot be
      stored, so the device never registers and projects open read-only with 0 peers, without a clear message. CI
      provides an unlocked gnome-keyring for `desktop-e2e`. Product follow-up: show an explicit "no keychain" error.
- [ ] The public SwiftLaTeX TeX file server (`texlive2.swiftlatex.com`) answered HTTP 522 on 2026-10-09. CI is not
      affected because e2e uses the fake engine, but in-browser compilation in production depends on it. Consider
      self-hosting (`make up PROFILES=texlive`, see `docs/local-stack.md`).

## Bootstrap tasks left open at archive time

From `openspec/changes/archive/2026-10-09-bootstrap-p2p-latex-platform/`:

- [x] 1.3 / 2.1: superseded. Neon and Upstash are provisioned and every production build runs on Vercel through the
      Deploy workflow with a health check.
- [ ] 3.4: send a manual smoke email through Gmail SMTP with the production credentials.
- [ ] 8.5: real in-browser compile with SwiftLaTeX in Playwright (blocked by the public TeX server, see above).
      Persisting downloaded packages in Cache Storage is also still open.
- [x] 9.5: signed release builds via tag `v*` (latest v0.7.1).
- [ ] 10.7: check the GitHub App setup in `docs/github-backup.md` against a freshly created App.
- [ ] 11.1: full e2e on a Vercel preview (2 web clients + 1 desktop).
- [ ] 11.3: measure free-tier usage over a 1-week beta. `USAGE_LOG=1` is on in production; see TODO.md (Upstash baseline).
- [x] 11.4: production is promoted, the admin is bootstrapped and releases are published.
