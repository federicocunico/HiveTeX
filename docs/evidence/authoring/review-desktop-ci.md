# Selective desktop and CI review

Reviewed the uncommitted `stabilize-authoring-workspace` changes against `HEAD` (`2a8d2ed`) on 2026-10-24, after the separate compiler and workspace reviews. This was the sole active reviewer. No production fixes, installer builds, Sandbox launches, TeX installations, full browser/CI runs, commits, pushes or archive operations were performed.

## Findings

**No additional confirmed P1/P2 finding** was established in this selective pass. This means no actionable defect was confirmed in the inspected delta; it does not replace the native, packaged or hosted CI acceptance runs.

Previously resolved compiler-generator/XeTeX/cancellation and PDF-renderer findings were not reopened. `BUGS.md` and `__conntests.txt` were not modified. The abandoned staging directories documented in `review-workspace.md` were not removed or retried.

## Scope inspected

- Native lifecycle: `lifecycle.rs` and the setup/single-instance wiring in `lib.rs`. Inspected startup readiness and pending-open atomics, coalescing of reentrant reconstruction, hidden-until-constructed replacement windows, existing close/tray/quit behavior, background startup and worker ownership. The sequential startup-state unit test covers pending request consumption; the recorded real concurrent/package evidence remains separate.
- Native compiler: `tex.rs`, `tinytex.rs`, `tex_cli.rs` and managed/native TypeScript tests. Inspected one deadline shared by TeX/BibTeX/package attempts, cancellable managed-distribution lock waiting, package recovery marker/index repair, temporary output-file ownership, Windows descendant accounting and job termination, helper/native build namespaces and bridge prerequisites. Read the existing maintenance/read-lock and compiler-health callers to check interaction with repair. The unchanged general build/detection hardening was context, not presented as newly verified security coverage.
- Harnesses: `run.mjs`, `lifecycle.mjs`, `background.mjs`, `packaged-lifecycle.ps1`, `verify-packaged-sandbox.ps1` and the shared existing harness. Inspected owner/path filtering, temporary executable/profile handling, native telemetry, expected hidden-window counts, secondary exits, report persistence, process-tree cleanup and Sandbox-only installation guards. No harness was used to operate an installed application.
- Required acceptance: `.github/workflows/ci.yml`, `.github/workflows/desktop.yml`, `ci-browser-policy.test.ts`, both Playwright configurations, production bundled-workspace tests and native-authoring tests. Inspected required versus advisory jobs, zero-retry commands, PowerShell exit propagation, opt-in environment variables, prerequisite failure behavior and retained diagnostics. Desktop production packaging and its upgrade/self-check steps remain distinct from the E2E-identity WebView test lane. The new Sandbox package runner is a local acceptance harness, not an automatically invoked CI job.
- Also inspected the small `texcache.rs` distribution-identity delta and the browser service worker/cache setup where it affects production offline acceptance.

## Selective checks executed

| Check | Result |
| --- | --- |
| `cargo test --locked --lib lifecycle::tests -- --test-threads=1` | 3 passed |
| `cargo test --locked --lib package_acquisition_respects_deadline_and_kills_descendants -- --test-threads=1` | 1 passed; 4.26 s test |
| `cargo test --locked --lib tinytex::tests -- --test-threads=1` | 5 passed |
| `cargo test --locked --lib proc::tests -- --test-threads=1` | 3 passed |
| `pnpm --filter @hivetex/web exec vitest run test/ci-browser-policy.test.ts` | 5 passed |
| Node syntax checks for run/lifecycle/background harnesses | Passed |
| PowerShell parser checks for both new packaged/Sandbox harnesses | No parse errors |

Rust checks ran from `apps/desktop/src-tauri` on Windows against the existing local dependency/build cache. The first targeted Cargo invocation rebuilt the changed library test target in approximately 15 seconds; it did not build an installer or launch the app. No real TeX setup or compile was invoked by these selected tests.

An isolated Chromium probe checked a suspected weakness in the production offline test. It served a tiny page and controlling service worker from a disposable in-process loopback server, let that worker forward `/texlive/` requests with `fetch`, then installed the same `browserContext.route` abort pattern used by `bundled-workspace.spec.ts`. Result: `controller=true`, `routed=1`, `network=0`, request failed. Thus this installed Playwright/Chromium combination intercepts the worker's network request; the suspected routing bypass was **not reproduced and is not a finding**. The probe was sent through stdin and left no test fixture in normal discovery; its browser and server were closed.

## Residual gaps

- No macOS/Linux native WebView or Unix process-tree execution occurred. The documented missing platform acceptance remains missing, rather than inferred passing from Windows checks.
- The focused package test proves termination when its launcher is still alive at the deadline; it does not independently reproduce a real tlmgr self-update whose launcher exits before its updater. Windows descendant-accounting code was inspected, while real package outage/retry/offline evidence was read as context and not repeated.
- The concurrent startup/close/reopen and tray measurements were reviewed through implementation and existing reports, not executed again in this pass. Focus return during compiler acquisition was not newly measured.
- No hosted workflow was triggered. Static CI policy tests and command inspection cannot establish runner availability, runtime budget or remote green status. Future authorized pushes must still monitor every triggered workflow as required by `AGENTS.md`.
- Existing Windows job assignment occurs immediately after spawn, and existing Unix handling does not query descendants after launcher exit. Neither was introduced by this delta; no new concrete failure was reproduced here. They are limits of this review's process-tree coverage, not asserted release blockers.
- Final acceptance/evidence refresh for the regenerated production distribution `tl2019-5eed4a4ac9c250ecc67f2f74` remains the coordinator's separate follow-up.

No actual usage-limit/reset metadata appeared during this pass; no live quota amount is inferred.
