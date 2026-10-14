# Windows maintenance and release checks

## Recover a compiler after several installations

Open **Account > Compiler > Clear compiler caches** when older versions left build files or downloaded packages that no longer work. This clears build outputs, Tectonic packages, temporary downloads and browser TeX files. It keeps documents, sign-in, preferences and installed compilers. Wait until running compiles or installations finish before clearing.

**Install full LaTeX** provides the app-managed TinyTeX, now preferred over system distributions. System detection skips failing version probes and selects all engines and build tools from one bin directory. A broken or hung PATH entry cannot keep detection waiting indefinitely. Separately installed MiKTeX/TeX Live versions are never deleted by the app.

## Upgrade and uninstall

A setup/MSI upgrade, an installer-format change and a signed update preserve local projects, settings and credentials. Install the new version over the old one when updating.

An **explicit uninstall removes HiveTeX's local data** for the Windows user running uninstall: local and roaming app folders, WebView state, retained/offline project replicas, compiler caches, app-managed TinyTeX/Tectonic, saved credentials and login startup. Back up work that exists only in the app before uninstalling. Linked project folders outside those app folders and separately installed TeX distributions are kept. Cleanup never follows a directory junction into an external folder. The data and credential namespace `app.p2platex.desktop` from v0.1.0/v0.1.1 is included. Other users' Windows profiles are outside the cleanup boundary.

The installer aborts if cleanup fails; close the app and retry. The setup confirmation explains local data removal. Both uninstallers invoke a maintenance command that starts no tray, editor or worker.

## Repeated app launches

Windows launches share a fixed app identifier across install paths and versions. The patched pinned single-instance plugin treats an existing mutex as another running instance even if its handover window is not ready. It waits for that window for up to three seconds, bounds the handover message to two seconds and always exits secondary launches. A hung first process cannot cause another tray or worker.

The app's one bundled Node worker may restart after a crash. Retries back off and stop after five restarts within ten minutes. The old worker is reaped before the replacement, and a Windows lifetime job prevents worker descendants outliving the app.

## Required checks and warnings

CI runs Windows builds, lint, types, bundle/dependency/security checks and unit tests. Desktop runs serialized native regressions plus the instance/background/restart harness without WebDriver. Release builds check packaged startup and both Windows installers, including setup/MSI conversion and complete uninstall, before publication. Signed updates and exact-source production deployment remain required.

Browser e2e diagnostics run on Windows as advisory checks; failures and successful retries produce explicit warnings with report/trace artifacts. Full desktop UI diagnostics are available by selecting **diagnostics** in a manual Desktop run and also report warnings. A plain manual run validates installers without WebDriver. Manual builds do not cancel push validation. Linux/macOS matrices and scheduled Docker/network labs no longer run automatically.

Reproduce the lifecycle check in PowerShell:

```powershell
$env:HIVETEX_LIFECYCLE_ONLY = '1'
pnpm --filter @hivetex/desktop e2e
```

It uses the isolated e2e app identity, delays the primary's handover window, launches twelve secondaries from two executable paths, then checks background reopen, browser pairing, update restart and login startup. It targets only its own executable paths. The artificial startup delay is compiled only in the test feature, never the published app.

Installer tests are in `scripts/verify-upgrade.ps1` and require a disposable runner (`CI=true`). They refuse an existing installation or app profile before starting. Native cleanup tests use their own temporary paths and verify junction isolation. The original affected user's exact environment is unavailable; these regressions establish the identified failure paths, not a claim to have reproduced every reported symptom.

## Validation for 0.7.3

Local Windows checks: all package unit suites passed (14 Turbo tasks); native suite passed 124 tests with five pre-existing opt-in tests ignored on the disposable Windows runner; build/lint and Svelte types passed (zero errors). The six lifecycle scenarios above passed, including twelve delayed/concurrent/cross-path launches. The cache reset regression also verifies active-build refusal, deletion-error propagation and repeated worker reset. Installer/CI results are recorded after the disposable-runner checks below.

Production ordering also recognizes the commit metadata of older Vercel CLI uploads, retaining the same project, SHA, ancestry and CI checks.
