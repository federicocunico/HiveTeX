## Why

Desktop users only learn about a new HiveTeX version if they open *Account → Check for updates*, so many stay on old
builds. Installing a new version on top of an old one (especially across the NSIS and MSI installers on Windows) can
leave two copies installed, which causes confusing, hard-to-diagnose problems.

## What Changes

- On every start, the desktop app checks GitHub for the repository's latest published release (no pre-releases, no
  drafts). If it is newer than the running version, a badge announces it with the version number and a **Download**
  button that opens the release page in the browser.
- The badge can be dismissed for that version; it comes back when a still newer version is published.
- The check never blocks the app and stays silent when offline or when GitHub is unreachable.
- The Windows installer removes any previous HiveTeX installation (NSIS or MSI) before installing the new one, keeping
  the user's data, so that exactly one version remains.
- The existing in-app *Check for updates* in Account stays as it is.

## Capabilities

### New Capabilities
- `update-notification`: startup check for a newer release and the badge that announces it.

### Modified Capabilities
- `release-distribution`: installers replace an earlier installation instead of living next to it.

## Impact

- `apps/web`: new update-check module and badge component, mounted only in the desktop app.
- `apps/desktop/src-tauri`: capability allowing the opener to open the project's release pages; NSIS installer hook.
- `.github/workflows/desktop.yml`: upgrade check of the Windows installer.
- Docs: README / deployment notes on updating.
- Out of scope: automatic download/installation from the badge, macOS/Linux installer behavior, telemetry.
