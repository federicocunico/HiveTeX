# Design

## Context

See proposal.md for the motivation. Today's behaviour this design builds on:

- **Documents:** a project is a root Y.Doc (the file list: id → path, kind, binary hash) plus one Y.Doc per text file
  (`f:<id>`), each persisted separately (`DocPersister`, IndexedDB in the webview). The mesh syncs a document with a
  linked peer through the Yjs sync steps (`STEP1` state vector → `STEP2` missing updates), started when a peer links or
  a document opens (`packages/sync/src/mesh.ts`).
- **Offline today:**
  - `loadMe()` falls back to a cached user when the server is unreachable;
  - `ProjectSession` uses a throwaway device identity (`offline-…`) when registration fails;
  - *Work offline* (`paused`) closes all links;
  - on reconnect everything merges as CRDT updates, character by character.
- **Folder mirror:** merges edits made while the app was closed using a stored per-path base and fuzzy patches
  (`diff-match-patch`). It has no notion of conflicts.
- **Server:** creates projects with a generated internal id and the chosen public ID (slug). Joining uses ID and
  password. Neither needs changes.

## Goals / Non-Goals

**Goals:**
- The desktop app works fully without an account. Local projects can later be shared, or merged into a shared project.
- Divergent work done without a peer link merges like git: one-sided changes silently, disjoint changes with a
  warning, overlapping changes only after the member decides. Nothing is ever lost, including across restarts.
- Live co-editing is unchanged.

**Non-Goals:**
- Merging live concurrent edits by lines.
- Branches, history rewriting, or choosing a merge base other than "what both sides last shared".
- Local mode in the web app (browsers keep requiring an account).
- Conflict detection for binary contents beyond "changed on both sides": no image diff.

## Decisions

### D1. The offline fork: keep unshared edits out of the shared documents until the merge

A device enters **fork state** for a project at the first *local* change (editor, folder mirror, import, file
operation) made while it has **no linked peer**.

- **Base snapshot:** at that moment, and lazily for each document first changed during the fork, it stores the
  document's state from just *before* the change (`Y.encodeStateAsUpdate` taken in `beforeTransaction`) as that
  document's **base**, persisted next to the document (`fork/<projectId>/base/<docId>`). A `fork/<projectId>/active`
  record marks the fork.
- **Remote updates:** none can arrive during a fork, since nobody is linked.
- **When a peer links:** before the first `STEP1` for each forked document, the mesh asks the merge manager to
  `prepare(docId)`:
  1. The current document (the member's version, "mine") is serialised and persisted
     (`fork/<projectId>/mine/<docId>`).
  2. The model swaps in a fresh document rebuilt from the base.
  3. Sync then runs on the base copy. The peer sees none of the offline operations, and this device receives the
     peer's changes ("theirs").
- **After the swap:** once the initial sync of that document completed (the peer's `STEP2` applied), the manager merges
  base / mine / theirs (D2, D3). It writes the result into the shared document as normal local edits (origin: this
  member, minimal diffs), or records conflicts (D4).

The editor rebinds to the swapped document: its file is reopened from the model, the same path used when a file is
replaced today. The fork ends when every forked document is merged or resolved; the `fork/*` records are then deleted.
If the link drops mid-merge, the persisted mine and base records let it resume at the next link.

*Alternatives:*
- **Keep CRDT and post-process interleavings:** it cannot reconstruct intent once operations are merged.
- **Store offline edits as text diffs instead of Yjs state:** it loses exact undo history and complicates the folder
  mirror. Snapshots are simpler, and the fork is short-lived.

### D2. Text merge: diff3 by lines

`node-diff3` (MIT, no dependencies, about 10 kB) computes a three-way merge of line arrays into stable and conflict
regions. An in-house LCS-based diff3 is the fallback if bundle or licence review rejects it.

- **Inputs:** base, mine and theirs texts are split on `\n`, keeping trailing newlines.
- **Clean results:** one side changed returns that side. Disjoint changes produce a result applied in one transaction
  (`fast-diff` from theirs to the result, so co-authors see only the member's lines change), and the file is added to
  the *merged with others' changes* warning.
- **Conflicts:** overlapping regions become hunks `{ base, mine, theirs }` with line ranges.
- **Whitespace:** none is ignored. LaTeX is line-oriented enough, and editors don't reflow. A change that only differs
  in trailing whitespace on the same lines is still a conflict, which keeps the rule predictable.

### D3. File-level merge (root document)

The file lists of base, mine and theirs are compared per file id, which stays stable across renames:

| Base | Mine | Theirs | Result |
|---|---|---|---|
| – | added | – | added |
| – | added P | added P (different id) | conflict: same path added on both sides (keep both: mine is renamed `P (mine)`) |
| present | deleted | unchanged | deleted |
| present | deleted | changed | conflict: keep (theirs) or delete |
| path A | renamed B | renamed C | conflict: choose B or C |
| path A | renamed B | unchanged | renamed B |
| binary h0 | h1 | h2 | conflict: choose mine or theirs (both blobs kept until decided) |

Text contents then go through D2 independently of renames.

### D4. Conflicts, warnings and the resolve view

- **Storage:** conflicts are persisted per project (`fork/<projectId>/conflicts`). Until a text file's conflicts are
  all decided, the shared document stays at theirs, so co-authors keep working. The file shows a "Conflict with your
  offline version" bar with **Resolve**.
- **Resolve view** (a dialog over the workspace, keyboard accessible):
  - a list of conflicting files;
  - for a text file, each hunk with base, mine and theirs and *Keep mine*, *Keep theirs*, *Keep both*, *Edit*;
  - file-level conflicts with their choices (D3).
  When a file is complete, its merged text is applied as in D2, and it can be undone with the normal undo.
- **Status:**
  - a toast at merge time: "Merged your offline changes: N files merged with others' changes (list), M conflicts to
    resolve";
  - a persistent status-bar pill "M conflicts" that opens the view;
  - the Sync panel lists the files.
- **Viewers or lost edit rights:** no merge. The fork is discarded with the existing read-only notice. Viewers
  cannot make local edits, so this only happens when rights were removed during the fork.

### D5. Local mode

- **Auth:**
  - the desktop sign-in screen gets *Continue without an account*, which sets `auth.local = true` with a local
    pseudo-user `{ id: 'local', username: 'You' }`, persisted, so the next start opens in local mode;
  - local mode never calls the API; `api()` refuses calls in local mode, as a guard;
  - the header shows *Local* and *Sign in*.
- **Projects:**
  - local projects have ids `local-<uuid>`, kept in a small local registry (`hivetex.localProjects` in IndexedDB) with
    name and dates;
  - the projects page lists them under *On this computer*, also when signed in;
  - templates, import, folders and the Files menu work as for shared projects.
- **Session:** for a `local-…` id, `ProjectSession` skips device registration, tickets, the mesh, signalling, the
  election and GitHub backup. The compile mode is "this device only" (native compiler on the desktop). The fork
  machinery is not needed: there is never a peer.
- **Publish** (signed in): create the project with the existing API (chosen ID and password), open its session, copy
  every local file into it, move the folder binding and location to the new id, then remove the local project. These
  are all new files, so no merge is needed.
- **Link** (signed in): join the existing project, then run the D1–D4 merge with an **empty base** and the local
  project as mine. Files present on only one side are kept; differing same-path files are conflicts. Afterwards
  everything is resolved, the local project is removed and its folder binding moves to the linked project.

### D6. Tests

- **Unit:**
  - diff3 wrapper: one-sided, disjoint, overlapping, trailing newline, CRLF;
  - file-level merge table (D3);
  - local project registry.
- **Sync (packages/sync, in-memory mesh testkit), device A with Work offline:**
  - A edits paragraph 1 and B edits paragraph 3: clean merge with a warning, devices identical;
  - both edit paragraph 2: a conflict; B keeps theirs, A resolves *keep both*, and B receives it;
  - A restarts with the conflict pending: it is restored;
  - delete versus modify, rename versus rename, binary versus binary.
- **Browser (Playwright):** two contexts, A pauses, both edit, A resumes. The merge toast, the conflict pill, resolving
  in the dialog, and B seeing the result.
- **Desktop UI:** Continue without an account, a local project with a PDF, then sign in, Publish, and the shared
  project opens with the files. Link into a project with a conflicting `main.tex`, resolve, done.

## Risks / Trade-offs

- **[Risk] Swapping a document under an open editor.** Mitigation: the swap happens before the first sync message,
  the editor reopens from the model (as for a file replaced today), and the cursor is restored by line. A Playwright
  test covers typing during the swap.
- **[Risk] Being "alone online" is common (co-author not online at the same time), so many sessions end with a merge.**
  Mitigation: one-sided changes merge silently, so most reconnections show nothing; a warning appears only when both
  sides changed a file.
- **[Risk] A big project with long offline work makes the base snapshots large.** They are taken only for documents
  changed during the fork, and they are Yjs state (compact).
- **[Trade-off] Line granularity.** Two edits on the same long line (a whole paragraph written on one line) conflict
  even if they touch different words. That's git's behaviour and the expectation here; it's stated in the docs.
- **[Risk] The local registry is lost if app data is wiped.** That's the same as for in-app projects today. Folders
  remain the durable option and are recommended in the local-mode intro.

## Migration Plan

- **No server or data migration.** Existing projects and devices are unaffected until a device forks.
- **Older apps:** old versions keep merging CRDT-style and never fork. Mixed versions still converge: a new device
  forks and merges, then shares a normal result.
- **Rollback:** reverting the change leaves any `fork/*` records unused. A pending fork's mine version is still in its
  persisted record, and a recovery note in the docs explains how to export it.

## Open Questions

- **Exact name of the local pseudo-user shown on presence when a local project is later published:** cosmetic. The
  real account name is used once signed in.
