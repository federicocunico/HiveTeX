# Proposal

## Why

The desktop app cannot be used at all before signing in to a HiveTeX server. Offline work exists only for accounts
that already signed in once, with cached credentials. Someone on a plane, behind a firewall, or who simply does not
want an account yet cannot write a paper with it.

Work done offline is merged character by character (CRDT) on reconnect. That never fails, but when the author and a
co-author both rewrote the same lines, the result silently interleaves both versions. Authors expect what git does:
merge what can be merged, say so, and ask about the rest.

## What Changes

- **Local mode (desktop):** *Continue without an account* on the sign-in screen.
  - Projects are created, edited, compiled, kept in folders and opened in terminals on this computer only.
  - Nothing is sent anywhere, and no server is contacted.
  - The projects page lists them under *On this computer*.
- **Share a local project later:** after signing in (from the app header or the projects page), a local project can
  be:
  - **published:** it becomes a normal shared project with an ID and password, holding exactly the local files;
  - **linked to an existing project:** join it by ID and password, and the local files are merged into it.
- **Git-style merge of offline work.** A device that edits with no peer linked (no network, *Work offline*, local mode,
  or nobody else online) keeps those edits on its side. At the next link, each file is merged three-way by lines
  against the state both sides last shared:
  - a file changed on one side only is taken as is;
  - changes in different places of the same file merge automatically, with a warning that lists the files;
  - changes to the same lines are **conflicts**. A resolve view shows both versions per conflict (*keep mine*,
    *keep theirs*, *keep both*, or edit). A file with conflicts is shared only once all of them are resolved.
- **File-level cases:** a file added on one side is added; deleted on one side and unchanged on the other is deleted;
  deleted on one side and changed on the other, renamed differently on both, or a binary changed on both sides is a
  conflict with an explicit choice.
- **Unchanged:** live co-editing while connected stays character by character, instant and conflict-free.
- **BREAKING (behaviour):** concurrent offline edits to the same lines are no longer interleaved automatically; they
  need a decision.

## Capabilities

### New Capabilities

- `local-mode`: using the desktop app without an account, local projects, and publishing or linking them after
  signing in.

### Modified Capabilities

- `peer-sync`:
  - *Conflict-free merging* is limited to live edits;
  - *Offline editing* now merges git-style, with warnings and conflict resolution;
  - a new requirement covers resolving merge conflicts.
- `user-accounts`: *Sign-in and sessions*: the desktop app can be used without signing in (local mode); signing in
  later keeps the local projects.

## Impact

- **Sync** (`packages/sync`):
  - an offline fork: base snapshot per document when the first unshared edit happens, persisted;
  - on the next link, the docs are rebuilt from the base, synced, and the three-way merge result is applied as the
    member's edits;
  - a line-based diff3 with conflict hunks;
  - file-level merge of the file list (adds, deletes, renames, binaries).
- **Web app** (`apps/web`):
  - local-mode auth state and local project storage and listing;
  - a *Sign in to share* flow, Publish and Link;
  - the merge warning and the conflict resolve view;
  - session changes so a local project never touches the server.
- **Desktop:** no Rust changes expected (local mode reuses folders, terminals and the native compiler).
- **Server:** no change. Publishing uses the existing project creation, linking uses the existing join.
- **Dependency:** `node-diff3` (MIT, no dependencies) for the line merge, or an equivalent in-house diff3.
- **Tests:**
  - unit: diff3, file-level merge, fork persistence;
  - sync: the testkit with a paused device;
  - browser (Playwright): offline conflict and resolve, auto-merge warning;
  - desktop UI: local mode, publish, link with merge.
