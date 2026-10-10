# Design

## Context

Motivation: `proposal.md`. Requirements: the delta specs of this change. What exists today (observed in code):

- `ProjectSession` stores the CRDT in IndexedDB (`hivetex-project-<id>`) on both web and desktop (the desktop UI is the
  same web app inside Tauri). A folder can be attached on desktop only (`bindFolder` → `tauriFs` → `MirrorSync`). The
  folder path is remembered in `localStorage['hivetex.mirror.<id>']` and re-bound on open. Since `security-hardening`
  the path must also be in the Rust allowlist filled by `mirror_pick`.
- `MirrorSync` (`packages/sync/src/mirror.ts`) is written against an `FsAdapter` (`list/read/write/remove/watch`). It:
  - merges disk edits with a 3-way merge whose base is kept **in memory**;
  - stabilises reads;
  - tags disk edits with the Yjs origin `'mirror-import'`.
  On a fresh bind, `initialReconcile` imports everything if the project is empty. Otherwise it applies a **whole-file
  diff** from disk, which would undo co-author edits made while the app was closed.
- History today is whole-project snapshots (`captureSnapshot`, every 10 min, plus restore). Nothing attributes or
  shows individual changes.
- The control plane has no "last opened". `GET /projects` returns memberships unordered.
- The GitHub backup writes `.hivetex.json` = `{version: 1, paths}` into the repository.
- Signaling (`server/src/signal/hub.ts`): presence is a hash keyed by device id. Cleanup of a session does
  `removePresence(dev)` and publishes `{t:'leave', dev}` unconditionally, so a stale session of the same device erases
  the new one (`TODO_CI.md`).
- CI: no desktop UI tests; actions on Node 20; `make test-stack` is never run in CI.

## Goals / Non-Goals

**Goals:**
- One mental model on every device: a project is either "in the app" or "in a folder". The folder is plain files the
  user owns.
- Same folder behaviour on desktop and on Chromium web, through one `FsAdapter` contract.
- Correct 3-way merge for edits made while the app was closed.
- Visible, attributable and undoable changes without locks or staging.

**Non-Goals:**
- A git client inside the app (commits, branches). Users keep using git in the folder; `.git/` is ignored.
- Syncing folder *paths* between devices (paths are per device and private).
- Firefox/Safari folder support (no File System Access API).
- A server-side history.

## Decisions

### D1. Locations registry (per device)
`lib/locations.ts` keeps `{ [projectId]: { kind: 'app' } | { kind: 'folder', label, desktopPath? , handleKey? } }` in
IndexedDB (`hivetex-locations`). Directory handles are structured-cloneable there, which `localStorage` cannot hold.
The old `hivetex.mirror.<id>` keys are migrated on first run. The projects page reads it to show "📁 folder-name".
Nothing from it is sent to the server.

### D2. Web `FsAdapter` on the File System Access API (`lib/fs-access.ts`)
- **Folder picking:** `showDirectoryPicker({ mode: 'readwrite' })`. A handle can only come from a user gesture, so the
  web equivalent of the desktop allowlist is inherent.
- **Operations:**
  - `list`: recursive walk that skips ignored directories early, as the Rust walker does.
  - `read`: `getFileHandle(...).getFile()`.
  - `write`: `createWritable()` + `write` + `close()`, which commits atomically through the browser's swap file.
  - `remove`: `removeEntry`.
- **Watching:** a `FileSystemObserver` when available (Chromium 129+ behind a flag/origin trial). Otherwise polling
  every 1.5 s over a `path → (size, lastModified)` map, emitting changed, added and removed paths. That meets the 3 s
  requirement.
- **Permission:** on open, `queryPermission`. If it says `prompt`, the workspace shows "Allow access to <folder>",
  which calls `requestPermission` (a user gesture is required). Until then the project runs from IndexedDB.
- **Detection:** `'showDirectoryPicker' in window`. Otherwise folder actions are disabled with an explanation.

### D3. Persistent merge base (edits while closed)
`MirrorSync` persists its per-path base **text** (not CRDT state) in the project store's meta (`mirrorBase`), updated
whenever it writes a file or imports a disk change. On bind, for a text file that differs on disk:
- **disk ≠ base and project ≠ base:** a 3-way merge. `diff-match-patch` patches from base → disk are applied to the
  current project text (fuzzy, context-based), and the result is applied with `applyTextDiff`.
- **disk ≠ base and project = base:** import the disk version.
- **No base** (a folder never bound before): today's behaviour.

For a folder with existing content and a non-empty project with no base, the disk version is taken (the user chose
this folder), as today.

Rejected alternative: storing Yjs state per path as the base. It's precise, but large and tied to one CRDT state.
Text is enough for patches.

### D4. Folder marker `.hivetex.json`
Format: `{ "version": 2, "project": { "id", "slug" }, "paths"?: [...] }`.
- **On disk:** `MirrorSync` writes it on bind (only the `project` part; it keeps `paths` if present) and ignores it as a
  project file. It is added to `DEFAULT_IGNORES`; mirror and import treat it as metadata.
- **In the backup:** the GitHub backup writes `version: 2` with `project` and `paths`, so clones carry the identity.
  `importRepo` already skips `.hivetex.json`.
- **Reading it:**
  - Desktop: bind a temporary id on the picked folder, `mirror_read('.hivetex.json')`, then unbind. No new Rust
    command: the existing confined commands suffice.
  - Web: read through the directory handle.

### D5. Open folder / create from folder (projects page)
1. Pick a folder (desktop `mirror_pick`, web `showDirectoryPicker`).
2. Read the marker:
   - **Known project, member** (`GET /projects/:id` succeeds): save the location, then open the project. The workspace
     binds the folder; D3 merges edits made while closed.
   - **Marker present, not a member:** open the join form pre-filled with the slug. After joining, continue as above.
   - **No usable marker:** a dialog "Create a project from <folder>" (ID defaults to the folder name, password, keep
     unprotected toggle) creates the project, saves the location, and opens the workspace.
3. The workspace binds the folder. For an empty project, `initialReconcile` imports the tree (same ignore rules as the
   mirror). Main file and compiler are then detected with `lib/import/detect`, as for zip imports.

Files over `MAX_BLOB_BYTES` are skipped by the mirror with a notice (they could not be transferred to peers anyway).

### D6. "Store in a folder" at creation and per-project location menu
The creation form gets "Where: In the app (default) / In a folder…", shown when folders are supported. The workspace
toolbar's "Link folder…" becomes a **Location** menu:
- "Use a folder…" binds and copies the project to the folder (the folder must be empty or contain only ignored files;
  otherwise the user is asked to choose between merging the folder into the project and picking another one);
- "Stop using folder" unbinds and keeps the files on disk;
- "Show in file manager" (desktop; uses the opener plugin, scoped to the bound folder).

### D7. Change log (`packages/sync/src/changelog.ts`)
- **Inputs:** `model.onDocUpdate(docId, update, origin)` for text docs, and file-table changes (`onFilesChanged`
  diffing the previous list).
- **Source classification by Yjs origin:**
  - `'mirror-import'`: folder on this device;
  - `LOCAL_ORIGIN` or editor transactions: this device's editor;
  - a `PeerConnection`: co-author `claims.uname`;
  - `'changelog-undo'`: undo;
  - `DocPersister`: ignored (load).
- **Grouping:** an open change set per source, closed after 3 s without updates from that source.
- **Content:**
  - For each touched text file: a `before` text (from a per-doc text cache kept current on every update) and an `after`
    text at close. What is stored is the `diff-match-patch` patch text (compact, context-based) plus added/removed line
    counts.
  - For the file table: created, deleted and renamed paths, plus binary changes (hash before/after).
- **Storage:** a new IndexedDB object store `changes` in the project DB (`Persistence.putChangeSet / listChangeSets /
  pruneChangeSets`; `MemoryPersistence` mirrors it for tests). Pruning keeps max(7 days, 500 sets).
- **Undo:**
  - Text: reverse each patch and `patch_apply` it to the *current* text (fuzzy), then `applyTextDiff` with origin
    `'changelog-undo'`.
  - Files: a created file is deleted, a deleted file is recreated from the `before` text (binary: from the blob hash
    if still available), a rename is renamed back.
  - The undo is logged as its own change set "Undo of …". If a hunk cannot be applied because later edits overlap,
    that file is reported "partially undone".
- **UI:** `ChangesPanel.svelte`, a toolbar toggle beside History. It lists sets newest first (source badge, relative
  time, files); expanding a file shows a line diff rendered from the patch. Undo is offered for editors and owners.

### D8. Account recents
- Migration `0002`: `memberships.last_opened_at timestamptz null`.
- `POST /projects/:id/opened` (member only, rate-limited 120/h) sets `now()`.
- `GET /projects` returns `lastOpenedAt` and sorts by it (desc, nulls last), then by `joinedAt`.
- The workspace calls `opened` once per open (best effort, ignored offline). The projects page shows "opened 2 h ago"
  and the local location (D1).

### D9. Signaling session ids (reconnect race)
- **Server:** each signaling session gets `sid` (random 16 bytes).
  - Presence values become `sid|ticket`.
  - `join` and `leave` messages carry `sid`.
  - Cleanup removes presence only if the stored `sid` matches. Memory backend: compare-and-delete. Upstash: a small Lua
    `EVAL`, atomic in Redis.
  - `leave` is published with `sid`.
- **Client (`ConnectionManager`):** remembers the latest `sid` per device from `ready`/`join` and ignores a `leave` whose
  `sid` is not the latest.
- **Mesh:** already replaces the old connection of the same device; no change.
- **Found while verifying (stack runs, 5.2):** two more causes of the "line 90" failure.
  - A deadlock: a peer that is not the gatekeeper closes its idle relay socket, so when the reopened device was
    announced (peer exchange) while the stale mesh link was still up, nothing retried once that link dropped, and the
    reopened device (higher id) waited for an offer forever. `ConnectionManager` now remembers devices announced with a
    *different* ticket than their live link's (a new session; routine peer exchange repeats the same ticket) and
    retries them when the stale link leaves.
  - A test bug: when the editor won the election, `full-flow.spec.ts` closed its tab and then expected it to be linked;
    the test now reopens the closed leader tab on the same device in both branches.
  - Signals relayed through the mesh (peers without a relay socket) went to an arbitrary peer, which dropped them
    unless it happened to be linked to the target: at seven devices the mesh stayed partial ("3 of 6 peers"), the cause
    of the `realtime.spec.ts` flake. Signals now go through a peer that announced a link to the target (`nbrs`), and
    a peer that is not linked forwards one more hop (at most 2) to one that is.

### D10. Desktop UI tests (`apps/desktop/e2e`, `tauri-driver`)
- **Build:** a debug build with cargo feature `test-picker`. `mirror_pick` then returns the path in
  `HIVETEX_TEST_PICK_DIR` (still recorded in the allowlist, so `mirror_bind` stays enforced). Release builds never
  enable the feature, and a Rust config test asserts the release profile/features don't include it.
- **Client:** a ~60-line W3C WebDriver client over `fetch` (`e2e/webdriver.mjs`) with `node:test`, instead of
  WebdriverIO: that library pulls a browser downloader with unpatched advisories (`extract-zip`, `basic-ftp`) that would
  fail the dependency audit, and the tests only need a handful of commands. The picker reads `.next-pick` in the test
  folder so each pick can return a different sub-folder.
- **Environment:** tests start the embedded-DB dev server (`server dev`, `E2E_*` flags) and point the app at it with
  `VITE_API_BASE`.
- **Scenarios:** link folder, open marker folder, create from folder, import folder, plus an external edit picked up
  in the editor.
- **CI:** a `desktop-e2e` job on `ubuntu-latest` (webkit2gtk + `WebKitWebDriver` + `xvfb-run`) and `windows-latest`
  (`msedgedriver` matching WebView2). macOS has no WebDriver for WKWebView, so it is skipped. Locally: `make desktop-e2e`.

### D11. CI hygiene
- Actions bumped to Node 24 majors: `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v6` (v5 still runs on Node 20),
  `pnpm/action-setup@v4.2+`, `Swatinem/rust-cache@v2.8+`, `dtolnay/rust-toolchain@stable`. Each version is checked in
  its release notes when applying.
- New `stack-nightly.yml`: `schedule` + `workflow_dispatch`; it builds the stack with `docker compose` and runs
  `make test-stack` with a 30-minute timeout.

## Risks / Trade-offs

- **[File System Access polling misses a change made and reverted within 1.5 s]** → harmless (no net change);
  `FileSystemObserver` is used when present.
- **[Fuzzy patch application in 3-way merge and undo can misplace text in heavily rewritten files]** → only for
  overlapping edits. Undo reports "partially undone", and snapshots still allow a full restore.
- **[A cloned repository has a marker for a project on another deployment]** → treated as "not accessible" and the
  user is offered to create a new project; the marker is rewritten only after they confirm.
- **[`tauri-driver` WebView driver version mismatches on CI images]** → pin `msedgedriver` to the installed WebView2
  version through `msedgedriver-tool`; Linux uses the distribution's `webkit2gtk-driver`.
- **[The control plane learns open times]** → accepted by the user; documented in `docs/security.md` (metadata).

## Migration Plan

- Database migration `0002` (nullable column) runs before deploying the new API (`make migrate-prod`).
- Signaling changes are backward-compatible for presence parsing: values without `sid|` are treated as legacy.
- Local storage: `hivetex.mirror.*` keys migrate to the locations registry on first run.
- Rollback: the old client ignores `lastOpenedAt` and `sid`.

## Open Questions

- Whether the WebView2 driver on `windows-latest` cooperates with `tauri-driver` without extra flags. If not, the
  Windows job is marked `continue-on-error` and the result is recorded in `TODO_CI.md` (Linux stays mandatory).
