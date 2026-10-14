# Design

## Context

See proposal.md for motivation. Native detection currently searches each tool independently across PATH and accepts failed version commands. The compiler panel clears only browser files. The NSIS hook only removes MSI installations during installation, and no explicit-uninstall data cleanup exists. Version 0.7.2 is in sources while the latest published version is 0.7.1.

The pinned single-instance 2.4.4 Windows implementation finds an existing mutex, but proceeds when the primary's communication window is absent. A race can therefore start a second tray and worker. Worker crash recovery already has a five-retry budget and needs verification, not a new process manager. CI has Linux/macOS matrices and repeated e2e timing failures; the latest Linux router lab also has a genuine unknown-command failure, which must not be mislabeled as a flake.

## Goals / Non-Goals

**Goals:** reproducible native regression checks; consistent compiler binaries; recoverable cache reset; uninstall/upgrade separation; Windows installers verified before publication.

**Non-Goals:** system TeX repair/removal, deleting externally chosen folders, replacing synchronization architecture, or claiming the original affected user's exact failure has been reproduced without their machine/logs.

## Decisions

1. Detect per bin directory with a bounded successful version probe, retaining the selected directory in EngineInfo. Prefer managed TinyTeX, then working system candidates, then managed Tectonic. Pin all build/package-discovery tool lookups to that directory and prevent inherited TeX configuration from mixing another distribution into managed builds. An existence-only probe was rejected because stale executables can exist but fail or hang.

2. Serialize compiler mutation/reset with native compile activity, including the loopback helper. Reset only an explicit list of app-owned cache subdirectories, clear missing-package memoization, and invalidate engine discovery. Keep installed distributions and project stores. Report deletions that fail; avoid recursive traversal of reparse points.

3. Patch the pinned single-instance plugin locally, preserving its existing Windows identity and communication protocol for earlier installed versions. A secondary process waits briefly for the handover window, sends with a deadline, and always exits; absence of the window never authorizes duplicate startup. Check mutex/window errors rather than continuing without protection. Preserve the plugin cleanup contract for update restarts. Exercise the race with an isolated test identity and a deterministic delayed primary in a native process harness.

4. Add a maintenance-only command that performs scoped current-user uninstall cleanup without initializing Tauri, tray or worker. Integrate it into NSIS and WiX uninstall paths before files are removed. Preserve state during NSIS /UPDATE replacement and MSI UPGRADINGPRODUCTCODE removals, including MSI-to-NSIS conversion. Remove only app credential entries, autostart registration and exact known app identifiers' local/roaming directories; never follow linked external folders. Explain the explicit-uninstall data loss in docs/installer UI.

5. Keep CI and Desktop workflow names so release/deploy checks remain compatible. Collapse static and unit work onto Windows, keep required native/build/install gates, and run browser/desktop network/UI diagnostics in an advisory Windows job or on demand. Emit explicit warning annotations and retain diagnostic reports. Remove scheduled Docker/Linux labs instead of running unsupported tests; maintain required deterministic checks and signed publication/serialized deployment.

## Risks / Trade-offs

- The affected machine's exact compile failure is unavailable → validate broken/hung/mixed installations and stale cache recovery and report this limit.
- Uninstall loses app-owned offline-only replicas → explain that explicit uninstall removes local data; upgrade preserves it and external folders remain.
- An installer running for a different user cannot clean every Windows profile's credentials → scope cleanup to the installing user's data/credential store; preserve OS isolation.
- A hung primary cannot be focused → secondary exits after a deadline and never creates duplicate identities.
- Advisory diagnostics can hide a real failure if ignored → keep warnings and artifacts explicit; deterministic native regressions and packaged checks remain mandatory.

## Migration Plan

Sync master first; preserve untracked user files. Write/validate the change, apply with Windows checks, update all versions using set-version.mjs and document the regression evidence. Archive only after tasks and verification complete. Push master and wait for terminal CI/desktop/deploy status, then push the unused version tag. Monitor installer publication and checked production deployment until terminal, fixing actionable failures before reporting readiness. Rollback uses a new patch release; never move a published tag.

## Deployment verification finding

The pre-existing production deploy failed because its source was uploaded through the Vercel CLI and the guard did not read CLI `meta.gitCommitSha`. The authenticated CLI verified the production deployment ID, correct project, READY state and the known ancestor commit b8768d8. Accept this existing metadata field alongside GitHub/HiveTeX fields; preserve project identity, SHA format, ancestry and exact-CI checks. No credential files or tokens are needed for this inspection.

Published v0.1.0/v0.1.1 used `app.p2platex.desktop`; include its app-owned cache/profile/credential namespace in explicit cleanup. Cache reset preserves documents in both namespaces and refuses a linked data root. The isolated test identity never cleans the production or legacy namespaces.

Production delivery uses project-scoped REST operations to create an immutable Git-source production build without automatically assigning domains, verify its actual source and health, then promote it and confirm the alias. This avoids the CLI user/team lookups that reject project-scoped tokens; the existing CI secret is retained. Protected health checks require the existing automation bypass secret. API create/promote contracts follow Vercel v13 deployments and the CLI v10 promote endpoint.

Installer verification identified quoted NSIS InstallLocation values and asynchronous temporary uninstaller handoff. Tests normalize the stored path, wait boundedly for registration removal, and retain the original failure. MSI replacement runs the NSIS uninstaller in-place with /UPDATE, then removes only its remaining uninstall.exe and empty directory; fixtures verify the old program is gone.

The required live-maintenance regression reproduced Windows sharing violation 32 in the WebView No_Vary_Search journal after the app exited. Explicit uninstall retries only app-owned profile removal for up to five seconds per profile, then reports failure. Locked-file fixtures verify eventual release and persistent failure; the native race remains a required regression, not an advisory diagnostic.

The installer harness matched cmdkey’s query heading, which repeats an absent target name. Match actual Target rows instead; a synthetic credential verifies absent/present/deleted states, and upgrade checks cover both current and legacy credentials. The tag gate falls back to public exact-source Actions metadata when CLI access is unavailable, retaining existing workflow permissions.

An installer harness run hung beyond its operation budgets. Use direct CreateProcess invocation, explicit progress and MSI logs, bounded WMI queries and a ten-minute step budget; retain successful Rust compilation in cache across installer failures. The MSI-to-setup removal action uses existing TARGETDIR as its working directory, since the new INSTALLDIR is not created before InstallInitialize.

Tauri MSI deliberately reuses the earlier NSIS installation directory. Validate one MSI registration and absence of the old uninstaller; require the old executable to disappear only when installation paths differ. Use the ARPINSTALLLOCATION already supplied by the Tauri template for the installed directory. Remove the obsolete optional data checkbox and duplicate recursive deletes from NSIS; maintenance performs the full safe cleanup, explicit removal clears installer preferences, and replacement calls always pass /UPDATE. The isolated NSIS probe verified program and installer-key removal.
