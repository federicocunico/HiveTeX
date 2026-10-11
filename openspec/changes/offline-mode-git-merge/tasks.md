# Tasks

## 1. Merge engine (packages/sync)

- [x] 1.1 Text merge: a diff3 wrapper over `node-diff3` (or an in-house diff3) returning one-sided, clean or conflict hunks (D2).
  - Verify: unit tests for one-sided, disjoint, overlapping, trailing newline and CRLF cases.
- [x] 1.2 File-level merge of base / mine / theirs file lists per file id: add, delete, rename and binary cases (D3).
  - Verify: unit tests, one per row of the D3 table.
- [x] 1.3 Fork state (D1):
  - lazy base snapshots taken in `beforeTransaction` for local changes made with no linked peer;
  - `fork/*` persistence (active flag, base, mine, conflicts);
  - restore after a restart.
  - Verify: unit tests with the in-memory persistence. An edit while alone creates a fork; an edit while linked does not; a restart restores the fork.
- [x] 1.4 Merge on link:
  - the mesh calls `prepare(docId)` before the first `STEP1` for a forked document;
  - the model swaps in the base copy; after the initial sync, base / mine / theirs is merged;
  - clean results are applied as minimal local edits, and conflicts are recorded;
  - the fork ends when everything is merged or resolved; the merge resumes after a dropped link.
  - Verify: sync tests with the testkit (A paused, B online):
    - disjoint paragraphs merge identically on both, with a warning event;
    - the same paragraph produces a conflict, B unchanged;
    - a restart with a pending conflict restores it;
    - delete vs modify, rename vs rename, and binary vs binary each produce a conflict.
- [x] 1.5 Conflict resolution API: decide a hunk (mine, theirs, both, or edited text) or a file-level choice. A complete file is applied and shared.
  - Verify: a sync test where *keep both* reaches B; partial resolution doesn't share the file.

## 2. Workspace (apps/web)

- [x] 2.1 Session wiring:
  - forward fork and merge events;
  - rebind the editor when a document is swapped;
  - expose `conflicts` and `mergedFiles`;
  - discard the fork for viewers, or when edit rights were lost (D4).
  - Verify: svelte-check, and a Playwright test that keeps typing during the swap without losing text.
- [x] 2.2 UI (D4):
  - the merge toast;
  - the status-bar pill "N conflicts";
  - the "Conflict with your offline version" bar on the file, with Resolve;
  - the resolve dialog (hunks with base, mine and theirs; Keep mine, Keep theirs, Keep both, Edit; file-level choices; keyboard access);
  - the Sync panel list.
  - Verify: a Playwright test with two contexts. A works offline, both edit the same paragraph, A goes back online: the toast and pill appear, A resolves *keep both* in the dialog, and B sees the result. A disjoint edit shows only the merged-files warning.

## 3. Local mode (desktop)

- [x] 3.1 Auth (D5):
  - *Continue without an account* on the desktop sign-in screen;
  - `auth.local`, persisted;
  - `api()` refuses calls in local mode;
  - the header shows *Local* and *Sign in*.
  - Verify: a unit test that `api()` throws in local mode; svelte-check.
- [x] 3.2 Local project registry and listing:
  - `local-<uuid>` projects;
  - the *On this computer* section, also when signed in;
  - templates, import, folders and the Files menu work for local projects.
  - Verify: unit tests for the registry; Playwright with a desktop-like stub is not possible (local mode is desktop only), so this is covered by 3.5.
- [x] 3.3 Local session: no registration, tickets, mesh, signalling, election or backup; compile mode "this device only".
  - Verify (done in the desktop UI test of 3.5 instead of a unit test, as it checks the real app): every request and WebSocket the page opens in local mode is recorded, and none reaches the server.
- [x] 3.4 Publish and Link (D5):
  - Publish creates the project, copies the files, moves the folder binding and location, and removes the local project;
  - Link joins the project and runs the merge with an empty base.
  - Verify: unit tests of the copy and link sequencing with stubs.
- [x] 3.5 Desktop UI test:
  - start with Continue without an account, create a local project from a template, compile (quick compiler), and check no request reaches the local server;
  - sign in, Publish: the shared project opens with the files;
  - another local project with a different `main.tex`, Link to the published one: `main.tex` is a conflict; resolve it with keep mine; done.
  - Verify: `make desktop-e2e`, wide and with `HIVETEX_WINDOW=1024x768`.

## 4. Docs and verification

- [x] 4.1 Docs:
  - docs/interface.md (local mode, conflicts and the resolve view);
  - a new docs/offline.md (fork, merge rules table, line granularity, recovery);
  - README (use without an account, offline merge).
  - Verify: links resolve.
- [ ] 4.2 Full verification:
  - `make check`, `cargo test --lib`, `make desktop-e2e` (wide and narrow);
  - `openspec validate offline-mode-git-merge`;
  - push, with CI and Desktop green.

## Workflow follow-up

- Archive `offline-mode-git-merge`, commit with the attribution lines, and push.
- Release 0.3.0 (`make version`, commit, `make release VERSION=0.3.0 CONFIRM=1`; the check requires CI to be green first).
