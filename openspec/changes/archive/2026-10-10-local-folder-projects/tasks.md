# Tasks

## 1. Folder model and persistence (sync package)

- [x] 1.1 Add `.hivetex.json` to the mirror ignore list and teach `MirrorSync` to write/keep the marker (`{version: 2, project}`) on bind; verify sync tests: marker written, never added to the project, existing `paths` preserved
- [x] 1.2 Persist the mirror merge base per path (project meta `mirrorBase`) and implement the 3-way reconcile on bind with `diff-match-patch` (disk vs base vs project); verify a sync test where the folder is edited "while closed" and a co-author edited another paragraph: both survive
- [x] 1.3 Skip files larger than `MAX_BLOB_BYTES` in the mirror with a notice; verify a sync test with an oversized file on disk

## 2. Change history

- [x] 2.1 `Persistence` gains change-set storage (`putChangeSet/listChangeSets/pruneChangeSets`) in IndexedDB and memory; verify persistence tests including pruning to max(7 days, 500)
- [x] 2.2 `ChangeLog`: source classification by Yjs origin, 3 s grouping, before/after capture as `diff-match-patch` patches, file-table changes (create/delete/rename/binary); verify sync tests: folder edits form one set, peer edits attributed to the co-author, load from storage ignored
- [x] 2.3 Undo of a change set (reverse patches on current text, file-table inverse, origin `changelog-undo`, logged as a set, partial-undo report); verify sync tests: undo after a non-overlapping co-author edit keeps it and converges on two peers; overlapping case reports partial
- [x] 2.4 `ChangesPanel.svelte` (list, per-file line diff, undo for editors) wired into the workspace; verify svelte-check and an e2e: an external-like edit (mirror origin via test hook) appears as a "Folder" change set with a diff, undo restores the text on a second user

## 3. Locations and folders in the app

- [x] 3.1 `lib/locations.ts` registry in IndexedDB with migration from `hivetex.mirror.*`; verify web unit tests (fake IndexedDB) for set/get/migrate/remove
- [x] 3.2 Web `FsAdapter` over the File System Access API (`lib/fs-access.ts`: list/read/write/remove, polling watcher, optional FileSystemObserver, permission query/request); verify unit tests against an in-memory fake of the FS Access API (change detection within one poll, ignored dirs skipped, atomic write path)
- [x] 3.3 Session: bind from the registry on open for desktop (path) and web (handle with "Allow access" when permission is `prompt`); Location menu (use folder / stop using / show in file manager); creation option "In a folder…"; verify e2e on Chromium with a stubbed `showDirectoryPicker` backed by an OPFS directory: create in folder, reopen re-binds, stop using keeps files
- [x] 3.4 Projects page: "Open folder…" (marker → open / join prefilled / create-from-folder dialog), detection of main/engine after the initial import, folder badge per project, unsupported-browser explanation; verify e2e (OPFS-backed picker): open a folder with sources creates the project with that tree; open a folder whose marker names a project the user belongs to opens it
- [x] 3.5 GitHub backup writes marker `version: 2` with project identity; verify `packages/github` tests (manifest content, importRepo still skips it)

## 4. Account recents

- [x] 4.1 Migration `0002` (`memberships.last_opened_at`), `POST /projects/:id/opened`, `GET /projects` sorted with `lastOpenedAt`; verify server tests (member only, ordering, nulls last) and that the embedded and Neon migrations apply
- [x] 4.2 Workspace reports opening (best effort); projects page shows recents order and "opened … ago"; verify e2e: open B then A, list shows A first on another context of the same user

## 5. Reconnect race (open point)

- [x] 5.1 Signaling session ids: presence `sid|ticket`, conditional removal (memory compare-and-delete, Upstash Lua), `sid` on join/leave; client ignores stale leaves; verify server signal tests: old session cleanup after a new session joins leaves presence intact and sends no effective leave; p2p e2e still passes
- [x] 5.2 Verify `e2e/full-flow.spec.ts` passes 10 consecutive runs locally and on the Docker stack (`make test-stack`)

## 6. Desktop UI tests and CI (open points)

- [x] 6.1 `test-picker` cargo feature for `mirror_pick` (env `HIVETEX_TEST_PICK_DIR`, still recorded in the allowlist) and a Rust test that the default/release features exclude it; verify `cargo test --lib` and `cargo build --release` without the feature
- [x] 6.2 `apps/desktop/e2e` with `tauri-driver` (minimal WebDriver client, see D10) (link folder, open marker folder, create from folder, import folder, external edit visible) and `make desktop-e2e`; verify locally on Windows
- [x] 6.3 Desktop workflow `desktop-e2e` job on Linux (xvfb, webkit2gtk-driver) and Windows (msedgedriver); verify it runs green in CI (Windows may be `continue-on-error` per design open question, documented in TODO_CI.md)
- [x] 6.4 Bump actions to Node 24 majors in all workflows and add `stack-nightly.yml` (schedule + manual); verify a CI run has no Node 20 deprecation annotation and a manual dispatch of the nightly job is green
- [x] 6.5 Close task 4.2 of the archived security change in `TODO_CI.md` (now covered by 6.2) and update the open-points list

## 7. Docs and integration

- [x] 7.1 Docs: `docs/folders.md` (locations, open/create from folder, marker, web support, AI tools workflow, changes view), update `docs/local-ai-tools.md` and README; verify links and that steps match the UI
- [x] 7.2 `make check` + CI + Desktop green; verify on a pushed commit
