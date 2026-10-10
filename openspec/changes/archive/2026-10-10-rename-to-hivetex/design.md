# Design

## Context

There are 321 occurrences in 143 files (archived changes excluded):

| Kind | Count | Examples |
|---|---|---|
| npm scope | 135 | `…/sync`, `…/protocol` … |
| localStorage keys | 29 | `….test`, `….compileForOthers`, `….mirror.*` |
| Folder marker / ignore file | 32 | the legacy marker and ignore file |
| Environment variables | ~20 | `…_API_BASE`, `…_TEST_PICK_DIR`, `…_DEV_STACK` |
| Plain text | ~60 | UI, docs, emails, comments |

Persistent identifiers (shown without the old prefix), which need care:

- **IndexedDB:**
  - `…-device` (`apps/web/src/lib/keys.ts`): the device's private keys on the web;
  - `…-project-<id>` (`session.svelte.ts`): offline CRDT copies;
  - `…-locations` (`locations.ts`).
- **Keychain service** named after the old identifier (`secrets.rs`): desktop device keys and session token.
- **Old Tauri identifier**: its app-data folder holds `picked-folders.json`, the allowlist of
  folders the user picked.
- **Protocol domains:**
  - `HANDSHAKE_DOMAIN '…/v1'` and `SIGNAL_DOMAIN '…/signal/v1'` (`protocol/wire.ts`);
  - `ENVELOPE_INFO '…/envelope/v1'` (`crypto`);
  - `TICKET_TYP '…-ticket'` (`protocol`).
- **Backup:** `BACKUP_BRANCH '…/backup'` and the legacy `BACKUP_TRAILER` (`github/backup.ts`).

## Goals / Non-Goals

**Goals:**
- No trace of the old name left in anything a user sees, or in code identifiers.
- No data loss on a device that ran a build under the old name.
- Folders and backup repositories from before keep working.

**Non-Goals:**
- Interoperability between clients from before and after the rename. There are no released clients, and keeping two
  protocol domains would mean permanent dual code paths.
- Renaming the Vercel project or the GitHub repository; both are already `hivetex`.
- Rewriting archived OpenSpec changes, which are history.

## Decisions

### D1. Mechanical rename, then targeted compatibility
1. **Rename by script.** `scripts/rename-to-hivetex.mjs` is run once and not kept. It replaces these patterns in
   tracked files, excluding archives:
   - the old npm scope → `@hivetex/`
   - the old desktop lib name → `hivetex_desktop_lib`
   - the old desktop crate name → `hivetex-desktop`
   - the old environment variable prefix → `HIVETEX_`
   - the legacy ignore file → `.hivetexignore`
   - the legacy marker file → `.hivetex.json`
   - the old name in text → `HiveTeX` (prose) or `hivetex` (identifiers), reviewed in the diff
2. **Regenerate the lockfile** with `pnpm install`.
3. **Re-add compatibility code by hand.** The script replaces everything, so these are restored explicitly with the
   old names:
   - legacy marker and ignore names;
   - the legacy backup trailer;
   - the storage and keychain migration.

### D2. Web storage migration (`apps/web/src/lib/migrate-legacy.ts`)
- Runs before anything opens storage (`main.ts`, awaited).
- Guarded by `localStorage['hivetex.migrated'] = '1'`.
- **localStorage:** copy every key with the old prefix to `hivetex.*` when the new key is absent, then remove the old key.
- **IndexedDB:**
  - `indexedDB.databases()` lists the databases with the old prefix. For each, if the `hivetex-*` counterpart does
    not exist, copy every object store
    (same names, key paths, indexes and records) into the new database, then delete the old one.
  - When `databases()` is unavailable (old Firefox), probe the known fixed names (the old device and
    locations databases) and the project ids from the cached project list (`hivetex.projects`).
- A copy that fails leaves the old database in place, and the migration retries on the next start; the guard flag is
  set only after success.

### D3. Desktop
- `tauri.conf.json`: `productName: "HiveTeX"`, `identifier: "app.hivetex.desktop"`, window title "HiveTeX".
- `secrets.rs` `get`: read the new service; if absent, read the legacy service, write the value under the new
  service, delete the old entry.
- **Picked-folders allowlist:** on setup, if the new app-data folder has no `picked-folders.json`, copy it from the old
  identifier's folder, in the same platform data dir.
- NSIS treats the new identifier as a different app, so an installed build under the old name stays until uninstalled. Acceptable
  because none were distributed. Release notes mention it.

### D4. Folder and repository compatibility
- **Mirror:**
  - `MARKER_FILE = '.hivetex.json'`, `LEGACY_MARKER_FILES` holds the legacy marker name.
  - `writeMarker` reads the new file, or else the legacy one (keeping `paths`), writes the new one, and removes the
    legacy file.
  - Both names are in `DEFAULT_IGNORES`.
  - The ignore file: `.hivetexignore`, falling back to the legacy ignore file.
- **Open folder:** `readFolderMarker` tries both names.
- **Backup:**
  - `MANIFEST_PATH = '.hivetex.json'`; the previous manifest is read from either name, and the legacy file is deleted
    in the same commit when present.
  - `BACKUP_BRANCH = 'hivetex/backup'`.
  - `isOwnCommit` accepts `X-HiveTeX-Backup: 1` and the legacy trailer.
  - `importRepo` skips both marker names.

### D5. Protocol domains
`hivetex/v1`, `hivetex/signal/v1`, `hivetex/envelope/v1`, `hivetex-ticket`. The server and the web app deploy together
(`make setup`), so the deployment is consistent. The release after this change is v0.2.0, which signals the
incompatibility.

### D6. Environment and CI
- GitHub variable `HIVETEX_API_BASE`: the workflow reads it, `make setup` sets it, and the setup removes the old
  variable if present.
- Server env: no variables with the old name exist in Vercel (checked: `TICKET_*`, `GMAIL_*`, `BOOTSTRAP_ADMIN`, the
  `KV_*` / `DATABASE_URL` integrations).
- `docker/.env.stack`: `HIVETEX_DEV_STACK`.

## Risks / Trade-offs

- **Search-and-replace can hit strings that must stay.** These are exactly the compatibility names; D1 step 3 restores
  them explicitly, and the tests cover them (legacy marker read, legacy trailer, storage migration).
- **IndexedDB copies are not atomic.** If the tab closes mid-copy, the old database is kept and copied again next time;
  the new partial database is deleted first.
- **A large diff makes later merges harder.** Nothing else is in flight.
