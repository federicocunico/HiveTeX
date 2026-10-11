# Tasks

## 1. Confirm the recorded behavior

- [x] 1.1 Run `packages/sync` tests `fork-confirm.test.ts` (viewer-only sharing) and `mirror-baseline.test.ts` / `mirror.test.ts` (viewer bind keeps extra files; later new files removed), and verify they pass

## 2. User docs

- [x] 2.1 In `docs/offline.md` (*The merge waits for confirmation*), add the accepted risk of the viewer-only path (a conflict with an editor who is not linked shows up when that editor links); verify the paragraph names the spec requirement *Offline work when only viewers are linked*
- [x] 2.2 In `docs/folders.md` (*Read-only members*), say that files not in the project are kept only at bind/reopen time (the file list may be incomplete) and that files created later are removed; verify it matches `mirror.ts` `viewerInitial` / `handleDiskChange`
- [x] 2.3 Add a short user-facing note in `docs/interface.md` (*Sync*) that compile, export and backup wait or are refused, naming the missing files, while the file list is not complete on this device; verify it links to `docs/offline.md`
- [x] 2.4 Add a *Known limits* note in `docs/offline.md` and in `docs/interface.md` that opening the same project in several tabs of the same browser profile is not supported (one device identity, no tab coordination); verify both notes exist

## 3. Validate

- [x] 3.1 Run `openspec validate record-v040-sync-decisions --strict` and verify it passes
