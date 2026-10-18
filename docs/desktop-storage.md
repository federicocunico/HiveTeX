# Desktop project storage

The desktop app keeps each shared project in a **native SQLite store** in its data directory
(`stores/<scope>.safety-v1.sqlite3`, where the scope is a SHA-256 of server, account and project; local projects use
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

*More → Export full recovery copy* writes readable project files plus a private archive of raw documents (including
orphans), retained blobs, snapshots, change sets and metadata. Its manifest lists SHA-256 hashes and any material that
could not be read. Unsaved live text and denied/pending ingress records are included. Keep this artifact private: it
contains deleted content and membership certificates as well as the current project. Export reports incomplete reads;
it does not claim that a partly unavailable project was fully backed up.

## Rolling back

- **Feature rollback** (`localStorage['hivetex.nativeStore'] = 'off'` in the desktop's developer console, or a later
  build that ships it off): no new migrations start. Projects already migrated **stay on the native store**: reopening the
  IndexedDB copy from before the migration would silently drop every later edit.
- **Installing an older version**: export the full recovery copy first. The safety format is additive but old clients
  cannot interpret tombstones safely. IndexedDB now uses database version 3, so an older version-2 opener refuses it
  rather than rewriting it. Native storage uses schema 2 in a new `.safety-v1.sqlite3` file. On first upgrade a verified
  SQLite snapshot of the old `.sqlite3` file is copied through a unique temporary file and atomically published; the old
  file remains untouched. An old desktop binary may see that pre-upgrade copy, which does **not** contain later work.
  Do not resume editing it as though it were current. Retain the new store and recovery export when downgrading.
  `exportToLegacy` is a developer recovery tool with digest verification; copying bytes does not make an old client
  understand the new data format. Unknown future SQLite or project safety versions are refused before mutation.

## One writer

A scope's store can be open in one place only (the native side refuses a second handle), and the runtime registry
gives each (server, account, project) a single runtime. Deleting a project's data deletes the native store (refused
while it is open) and the IndexedDB copy.

## Operation journal and retention

Each durable document transaction includes an `operation:record:*` descriptor (v2) committed with the document
update. The record holds a reversible delta proportional to the change: text edits with their position, removed and
inserted text, or the previous and new values of changed root keys (large deltas go to `operation:bytes:<id>:delta:*`
chunks). Records of one document form a chain (`prev`). A chain starts at a full preimage, `operation:snapshot:<sha256>`
plus chunks, stored once per distinct content: at the start of each group (another source, or a pause over 3 s), and
before a change that removes more than half of the content. History rebuilds the text before and after any record by
replaying the chain from its preimage. A document with an unknown shared type keeps exact state/update chunks instead.
Records of the unreleased v1 format (a full preimage and update per transaction in `operation:bytes:*`) are kept and
read as snapshots; they are no longer written. Failure commits neither side. Pending batches remain in memory and retry
with backoff; the workspace shows a save error until successful. A restart projects unapportioned operations into
Changes exactly once. `authored:*` descriptors refer to the original signed envelopes in `authored-bytes:*` chunks;
forwarding does not change the signer. Envelopes carry no preimage. Received live operations of one author on one
document are shown as one Changes group per run. Private `recovery:*` descriptors and byte chunks are not shared blobs;
`removed` records keep the last content of an entry a peer deleted physically (see protocol.md).

Deletions live in the root `tombstones` map, so a 0.8.0 client sees an ordinary deletion. A development store whose
tombstones are a `deleted` field inside `files` is converted at open (idempotent), in a local transaction.

Changes retains seven days and at least 500 groups. Pruning removes display groups only: raw operation records,
tombstoned documents, snapshots, binary versions, signed evidence and private recovery copies are not garbage-collected
by this release. The oldest displayed group is therefore not the oldest recoverable byte. Retention consumes disk;
storage failures block destructive reconciliation instead of authorizing loss. No automatic purge is part of this audit.

The local IPC uses bounded fragments for large storage values; it no longer fails solely because one valid document
exceeds an 8 MiB pipe frame after base64 encoding. Logical messages still have a 160 MiB resource limit. Native full
recovery export avoids aggregate history/snapshot replies: it creates an integrity-checked SQLite snapshot and streams
it in 1 MiB chunks, with a manifest hash. The archive also includes readable files and captured live Yjs states for
unsaved edits. Export handles are scoped to their store and editor attachment, and close/cancellation releases the copy.
An app crash may leave a private `.export-*.sqlite3` copy beside the database; preserve it if recovery is needed.
UI lists still have message resource limits. The ZIP is streamed to its destination: the native save dialog on desktop
(appended in 1 MiB calls), a chosen file in browsers with `showSaveFilePicker`, Blob parts otherwise. At most one
1 MiB piece (or one asset) is held beyond the project itself, and the SQLite copy is hashed as it passes. `VACUUM INTO`
runs on its own connection outside the global store lock, so other projects keep saving during the copy. The ZIP
format used has no ZIP64, so an archive estimated above 4 GiB minus 64 MiB is refused before the destination is opened
("Nothing was written"); one that grows past the limit while written is discarded. Insufficient memory/disk is
reported as an incomplete export, never by deleting retained material. Tests: `apps/web/test/recovery-export.test.ts`
and, opt-in with a volume that has 2 GiB free, the 1 GiB store test:

```powershell
$env:HIVETEX_LARGE_STORE_DIR = $env:TEMP
cargo test --locked --lib exports_a_one_gib_store -- --ignored --nocapture
```

Native folder replacements/removals keep the replaced file in a sibling `.hivetex-recovery/` directory only for the
duration of the publication: it survives a crash in between. Afterwards the copy is removed when its bytes match what
HiveTeX last wrote or read, and otherwise captured into the store's Recovery and then removed (see folders.md). The new
path is published without replacing a racing external file, also on file systems without hard links (FAT, exFAT).
Normal saves do not require a staging dialog.
