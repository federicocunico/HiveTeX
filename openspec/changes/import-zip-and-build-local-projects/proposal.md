# Proposal

## Why

In v0.10.0, a user can open locally supplied project sources yet encounter `Project inputs are unavailable: (file list)` with instructions to reconnect to a co-author. A locally initialized project must remain usable and buildable on its own device, and starting a project from an Overleaf or other source ZIP must be directly accessible from the projects home page.

## What Changes

- Add a visible **Import ZIP…** action on the projects home page alongside **Open folder…**, **Join with ID** where available, and **New project**, including the empty and local-mode views. Selecting a ZIP starts new-project creation with that source already selected; the user need not find the nested existing-sources section first.
- Reuse the existing on-device archive importer, preview, main-file/engine detection, filtering, limits, and coherent application. Imported projects contain their sources and assets rather than a template or the unopened ZIP.
- Make locally initialized file tables, imported text documents, binary assets, and build settings usable without peer confirmation, with durable initialization evidence that survives reopening and native worker restarts. Cover both ZIP creation and opening an existing folder as a new project.
- Restore usable local state before attempting peer acquisition, including evidence-backed recovery for affected v0.10.0 projects. Preserve the distinction between a complete local copy and a joined replica that has genuinely never received content.
- Make build recovery messages reflect the actual cause: local loading/storage, missing local content, peer-only content, compiler dependencies, or TeX source errors. An absent co-author is not a failure cause for a complete local project.
- Verify Nature Reviews and JBHI from `F:\github\data`, as ZIPs and folders, including reopen, local builds with zero peers, and subsequently serving the sources to a joining co-author.

## Capabilities

### New Capabilities

None. Extend the existing import and local compilation capabilities.

### Modified Capabilities

- `project-import`: Direct home-page ZIP creation and durable, locally complete initialization of projects from user-provided sources.
- `local-compilation`: Build readiness independent of peer presence, recovery of available local inputs, and cause-specific input diagnostics.

## Impact

- Web/desktop shared UI: `apps/web/src/views/Projects.svelte`, `Workspace.svelte`, `components/ImportDialog.svelte`, the import pipeline, and project/session initialization.
- Sync/storage: `ProjectRuntime`, `ProjectModel` availability persistence, native worker/catalog and renderer projection, folder initialization, and `acquireProject`.
- Compilation UI: `packages/compile/src/local.ts`, `failure.ts`, and `ProblemsPanel.svelte`.
- Regression coverage: import/availability/snapshot/native worker tests, browser end-to-end tests, and real desktop/compiler checks with the supplied samples. Update `docs/import.md`.
- No new archive library or content upload service; retain encrypted peer source synchronization and exclusively local generated output. No source-format or network-protocol breaking change is intended.

Desktop tray/process duplication is outside this change. The separate crash feedback concerned Codex and is not a repository defect report.
