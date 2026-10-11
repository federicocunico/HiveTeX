## 1. Release check and comparison

- [x] 1.1 Add `apps/web/src/lib/update-check.ts` with `compareVersions`, `parseRelease` (tag to version, `html_url`, ignores draft/prerelease) and `checkForUpdate` (fetch latest release, silent on any failure); unit tests in `apps/web/test/update-check.test.ts` cover 0.9.0 vs 0.10.0, `v` prefix, equal, lower, malformed, offline. Verify: `pnpm --filter @hivetex/web test`.
- [x] 1.2 Add dismissed-version storage (`dismissUpdate`, `isDismissed`, try/catch around storage) with tests for dismiss, restart, and a newer release after dismissal. Verify: same test command.

## 2. Badge

- [x] 2.1 Add `UpdateBadge.svelte` (version text, **Download** button, dismiss button, accessible roles, light/dark styles) and mount it from `main.ts` only when `isDesktop`. Verify: a test shows the badge for a newer version, none for equal, Download opens the release URL, dismiss hides it.
- [x] 2.2 Allow the opener to open the project's release pages in `apps/desktop/src-tauri/capabilities/default.json`. Verify: `pnpm --filter @hivetex/web build` and `cargo check` in `apps/desktop/src-tauri` pass.

## 3. Installer replaces the old version

- [x] 3.1 Add the NSIS installer hook that silently removes an MSI-installed HiveTeX before installing, and reference it in `tauri.conf.json`. Verify: the config is valid (`cargo check`) and the hook file is syntactically picked up by the Windows build in CI.
- [x] 3.2 Add `scripts/verify-upgrade.ps1` and a Windows step in `.github/workflows/desktop.yml`: install the last published setup silently, install the new one silently, assert a single HiveTeX entry in Apps and that user data remains. Verify: the script parses (`powershell -File` syntax check) and the step runs in the dry-run workflow.

## 4. Documentation and spec sync

- [x] 4.1 Document the badge and the upgrade behavior in `README.md` and `docs/deployment.md`. Verify: the sections exist and say that the badge links to the release page.
- [x] 4.2 Run `openspec validate desktop-update-badge` and the full web test suite. Verify: both pass.

## Workflow follow-up

- Apply in a separate branch, archive the change, merge into `master`.
