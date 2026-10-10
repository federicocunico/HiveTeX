# Design

## Context

There are 321 occurrences in 143 files (archived changes excluded):

| Kind | Count | Examples |
|---|---|---|
| npm scope | 135 | `@p2platex/sync`, `@p2platex/protocol` … |
| localStorage keys | 29 | `p2platex.test`, `p2platex.compileForOthers`, `p2platex.mirror.*` |
| Folder marker / ignore file | 32 | `.p2platex.json`, `.p2platexignore` |
| Environment variables | ~20 | `P2PLATEX_API_BASE`, `P2PLATEX_TEST_PICK_DIR`, `P2PLATEX_DEV_STACK` |
| Plain text | ~60 | UI, docs, emails, comments |

Persistent identifiers, which need care:

- **IndexedDB:**
  - `p2platex-device` (`apps/web/src/lib/keys.ts`): the device's private keys on the web;
  - `p2platex-project-<id>` (`session.svelte.ts`): offline CRDT copies;
  - `p2platex-locations` (`locations.ts`).
- **Keychain service** `app.p2platex.desktop` (`secrets.rs`): desktop device keys and session token.
- **Tauri identifier** `app.p2platex.desktop`: its app-data folder holds `picked-folders.json`, the allowlist of
  folders the user picked.
- **Protocol domains:**
  - `HANDSHAKE_DOMAIN 'p2platex/v1'` and `SIGNAL_DOMAIN 'p2platex/signal/v1'` (`protocol/wire.ts`);
  - `ENVELOPE_INFO 'p2platex/envelope/v1'` (`crypto`);
  - `TICKET_TYP 'p2platex-ticket'` (`protocol`).
- **Backup:** `BACKUP_BRANCH 'p2platex/backup'` and `BACKUP_TRAILER 'X-P2platex-Backup: 1'` (`github/backup.ts`).

## Goals / Non-Goals

**Goals:**
- No "p2platex" left in anything a user sees, or in code identifiers.
- No data loss on a device that ran a p2platex build.
- Folders and backup repositories from before keep working.

**Non-Goals:**
- Interoperability between p2platex-era and HiveTeX-era clients. There are no released clients, and keeping two
  protocol domains would mean permanent dual code paths.
- Renaming the Vercel project or the GitHub repository; both are already `hivetex`.
- Rewriting archived OpenSpec changes, which are history.

## Decisions

### D1. Mechanical rename, then targeted compatibility
1. **Rename by script.** `scripts/rename-to-hivetex.mjs` is run once and not kept. It replaces these patterns in
   tracked files, excluding archives:
   - `@p2platex/` → `@hivetex/`
   - `p2platex_desktop_lib` → `hivetex_desktop_lib`
   - `p2platex-desktop` → `hivetex-desktop`
   - `P2PLATEX_` → `HIVETEX_`
   - `.p2platexignore` → `.hivetexignore`
   - `.p2platex.json` → `.hivetex.json`
   - text `p2platex` → `HiveTeX` (prose) or `hivetex` (identifiers), reviewed in the diff
2. **Regenerate the lockfile** with `pnpm install`.
3. **Re-add compatibility code by hand.** The script replaces everything, so these are restored explicitly with the
   old names:
   - legacy marker and ignore names;
   - the legacy backup trailer;
   - the storage and keychain migration.

### D2. Web storage migration (`apps/web/src/lib/migrate-legacy.ts`)
- Runs before anything opens storage (`main.ts`, awaited).
- Guarded by `localStorage['hivetex.migrated'] = '1'`.
- **localStorage:** copy every `p2platex.*` key to `hivetex.*` when the new key is absent, then remove the old key.
- **IndexedDB:**
  - `indexedDB.databases()` lists `p2platex-*`. For each, if `hivetex-*` does not exist, copy every object store
    (same names, key paths, indexes and records) into the new database, then delete the old one.
  - When `databases()` is unavailable (old Firefox), probe the known fixed names (`p2platex-device`,
    `p2platex-locations`) and the project ids from the cached project list (`hivetex.projects`).
- A copy that fails leaves the old database in place, and the migration retries on the next start; the guard flag is
  set only after success.

### D3. Desktop
- `tauri.conf.json`: `productName: "HiveTeX"`, `identifier: "app.hivetex.desktop"`, window title "HiveTeX".
- `secrets.rs` `get`: read the new service; if absent, read `app.p2platex.desktop`, write the value under the new
  service, delete the old entry.
- **Picked-folders allowlist:** on setup, if the new app-data folder has no `picked-folders.json`, copy it from the old
  identifier's folder (`…/app.p2platex.desktop/`), the same platform data dir with the old identifier.
- NSIS treats the new identifier as a different app, so an installed p2platex build stays until uninstalled. Acceptable
  because none were distributed. Release notes mention it.

### D4. Folder and repository compatibility
- **Mirror:**
  - `MARKER_FILE = '.hivetex.json'`, `LEGACY_MARKER_FILES = ['.p2platex.json']`.
  - `writeMarker` reads the new file, or else the legacy one (keeping `paths`), writes the new one, and removes the
    legacy file.
  - Both names are in `DEFAULT_IGNORES`.
  - The ignore file: `.hivetexignore`, falling back to `.p2platexignore`.
- **Open folder:** `readFolderMarker` tries both names.
- **Backup:**
  - `MANIFEST_PATH = '.hivetex.json'`; the previous manifest is read from either name, and the legacy file is deleted
    in the same commit when present.
  - `BACKUP_BRANCH = 'hivetex/backup'`.
  - `isOwnCommit` accepts `X-HiveTeX-Backup: 1` and `X-P2platex-Backup: 1`.
  - `importRepo` skips both marker names.

### D5. Protocol domains
`hivetex/v1`, `hivetex/signal/v1`, `hivetex/envelope/v1`, `hivetex-ticket`. The server and the web app deploy together
(`make setup`), so the deployment is consistent. The release after this change is v0.2.0, which signals the
incompatibility.

### D6. Environment and CI
- GitHub variable `HIVETEX_API_BASE`: the workflow reads it, `make setup` sets it, and the setup removes the old
  `P2PLATEX_API_BASE` if present.
- Server env: no p2platex-named variables exist in Vercel (checked: `TICKET_*`, `GMAIL_*`, `BOOTSTRAP_ADMIN`, the
  `KV_*` / `DATABASE_URL` integrations).
- `docker/.env.stack`: `HIVETEX_DEV_STACK`.

## Risks / Trade-offs

- **Search-and-replace can hit strings that must stay.** These are exactly the compatibility names; D1 step 3 restores
  them explicitly, and the tests cover them (legacy marker read, legacy trailer, storage migration).
- **IndexedDB copies are not atomic.** If the tab closes mid-copy, the old database is kept and copied again next time;
  the new partial database is deleted first.
- **A large diff makes later merges harder.** Nothing else is in flight.
