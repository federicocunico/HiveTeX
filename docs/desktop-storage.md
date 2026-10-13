# Desktop project storage

The desktop app keeps each shared project in a **native SQLite store** in its data directory
(`stores/<scope>.sqlite3`, where the scope is a SHA-256 of server, account and project; local projects use
`local-<id>`). Browsers keep using IndexedDB. Code: `apps/desktop/src-tauri/src/store.rs`, the adapter
`packages/sync/src/native-persistence.ts`, and `apps/web/src/lib/project-store.ts`, the one place that opens, copies and
deletes a project's store.

Why: one authoritative store per (server, account, project) that a background process can own without a webview, with
all-or-nothing document/metadata transactions, durable commits (WAL, `synchronous=FULL`) and blobs published only after
their SHA-256 matches.

## Migration from 0.5.0 and earlier

Projects stored by earlier versions live in IndexedDB under the project id only. The first time the desktop opens such
a project it copies it into the native store:

1. **Lock and manifest.** One migration per project runs at a time. A manifest
   (`stores/migrations/<scope>.json`, replaced atomically) records state, progress, counts and checksums.
2. **Copy.** Raw Yjs updates of every document, blobs, history snapshots, change sets and every metadata key
   (completeness markers, offline-merge journals) are copied in bounded batches. Nothing is re-encoded or merged, and
   the IndexedDB source is never written.
3. **Verify.** The native store is reopened and its digest compared with the source's.
4. **Switch.** Only then does the manifest make the native store active. The IndexedDB copy stays as a recovery source.

| Manifest state | Meaning | What the app does |
| --- | --- | --- |
| absent / `pending` | not migrated | migrates on the next open |
| `copying`, `verifying` | interrupted | keeps using IndexedDB now; resumes (or restarts and re-verifies) on the next open |
| `needs-confirmation` | the old store cannot be tied to a server and account | opening stops before networking; confirm its origin or export the old cache locally |
| `done` (`active: native`) | migrated | opens the native store |

**If a migration was interrupted** (crash, full disk, quit): nothing to do. Work continues on the old store; the next
open resumes the copy. If the old store changed meanwhile, verification fails once, the copy restarts from scratch and
is verified again (`apps/web/test/project-store.test.ts`, `packages/sync/test/migration.test.ts`, which injects a
failure at every target write and every manifest write).

## Recovery export

Current project membership and a cached project ID do not identify the original account/server of an older cache.
The desktop checks recorded `storeAssociation` metadata or an earlier migration manifest. If neither establishes the
association, the workspace shows **Confirm this account and server, then migrate** and **Export older cache for recovery**.
Confirm only when the displayed account and server match the source of that cache. A recorded association with another
account/server cannot be overwritten by this confirmation; use the local export instead.

Confirmation is stored in the native manifest, leaving the original IndexedDB source intact. The older-cache export is
an encoded JSON recovery artifact containing raw Yjs updates/identities, assets, metadata (including recovery keys),
history snapshots and change sets. It does not start networking, a background seed or a migration.

*More → Export recovery copy* writes a zip of the project as held in memory, including edits storage refused. It works
whatever store the project uses and is the safe copy before any manual intervention.

## Rolling back

- **Feature rollback** (`localStorage['hivetex.nativeStore'] = 'off'` in the desktop's developer console, or a later
  build that ships it off): no new migrations start. Projects already migrated **stay on the native store**: reopening the
  IndexedDB copy from before the migration would silently drop every later edit.
- **Installing an older version** (binary downgrade): an older version only reads IndexedDB. First run
  `exportToLegacy` for each migrated project (from the console:
  `(await import('/src/lib/project-store.ts')).exportToLegacy({ kind: 'shared', project, account })` in a development
  build; release builds expose it under *Account → Storage* once the desktop dashboard lands). It copies the native store
  back into a fresh IndexedDB database, verifies the digest and marks IndexedDB active. Then install the older version.
  Without this step, export a recovery copy first.

## One writer

A scope's store can be open in one place only (the native side refuses a second handle), and the runtime registry
gives each (server, account, project) a single runtime. Deleting a project's data deletes the native store (refused
while it is open) and the IndexedDB copy.
