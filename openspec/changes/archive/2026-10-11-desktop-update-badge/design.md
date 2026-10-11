## Context

The desktop app is Tauri 2 with the Svelte web app as UI. `isDesktop` (`apps/web/src/lib/api.ts`) detects it. The CSP
already allows `connect-src https://api.github.com`. The Tauri updater plugin (in-place download and install) is used
only from *Account → Check for updates*. The opener plugin is allowed to open only the GitHub OAuth URL. Windows builds
ship both an NSIS setup (`.exe`) and an MSI. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Notify at startup, non-blocking, silent on failure.
- Exactly one installed version after running any Windows installer.

**Non-Goals:**
- Auto-installing from the badge (the user asked for a button to the site).
- Replacing the updater plugin flow in Account.
- Handling AppImage/dmg replacement (manual file operations by nature; `.deb` already upgrades in place).

## Decisions

1. **Query `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`.** This endpoint returns only the latest
   published non-draft, non-pre-release release, which matches the spec. Owner/repo derive from `SOURCE_URL` (forks
   override it). The running version comes from Tauri's `getVersion()`. Alternative: `latest.json` of the updater: it
   has no release page URL and is absent in unsigned builds.
2. **Pure `compareVersions` / `parseRelease` functions** in a small lib module, unit-tested (numeric segments, `v`
   prefix, malformed input gives no update). The badge component is thin.
3. **Mount the badge independently of the screens** from `main.ts` (desktop only), as a fixed-position element, so it
   shows on every screen, including the workspace, and needs no edit of each view.
4. **Dismissal stored in `localStorage`** as the dismissed version string; badge hidden when the latest equals it
   (wrapped in try/catch like other per-device preferences).
5. **Download opens `html_url` of the release** with the opener plugin; add an opener permission scoped to
   `https://github.com/<owner>/<repo>/releases*` in `capabilities/default.json`. Alternative: `window.open`, which is
   not reliable inside the Tauri webview.
6. **Windows replacement via an NSIS installer hook** (`bundle.windows.nsis.installerHooks`, `NSIS_HOOK_PREINSTALL`).
   Tauri's NSIS setup already uninstalls a previous NSIS install of the same identifier; the hook adds removal of an
   MSI-installed HiveTeX (found in the Uninstall registry keys by product name, removed with
   `msiexec /x {code} /qn /norestart`) and runs silently, without the "delete app data" option, so user data stays.
   Alternative: drop the MSI from the build, rejected because the release spec promises it and managed environments
   want it. The MSI itself already upgrades MSI to MSI through its upgrade code.
7. **CI verification**: a Windows step installs the previously published release silently, installs the freshly built
   setup silently, and asserts a single HiveTeX entry in the Uninstall registry keys.

## Risks / Trade-offs

- GitHub API rate limit (60/h per IP, unauthenticated) → one request per start; failures are silent.
- A fork without releases → 404 treated as "no update".
- MSI removal needs elevation → the setup already runs elevated in per-machine mode; a per-user install skips MSI
  removal when it cannot elevate and logs it, rather than failing the setup.
- Uninstalling the old version while the app runs → the Tauri setup already asks to close the app; the hook does not
  change that.

## Migration Plan

Ships with the next release. Installed older versions have no badge; they get it once the user installs that release.
Rollback: revert the change; installers behave as before.
