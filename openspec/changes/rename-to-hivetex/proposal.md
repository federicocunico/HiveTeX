# Proposal

## Why

The product is now called **HiveTeX**. The repository is `federicocunico/HiveTeX` and the deployment is
`hivetex.vercel.app`, but 321 places in 143 files still say p2platex, including:

- the app and window title;
- installer names (`p2platex_0.1.1_x64-setup.exe`);
- emails;
- folder files (`.p2platex.json`, `.p2platexignore`);
- the npm scope (`@p2platex/*`);
- environment variables;
- the desktop bundle identifier;
- storage and protocol identifiers.

The owner chose a **full rename**. Nothing has been published yet: both releases are drafts, and the deployment
has no users. This is the cheapest moment to also change the identifiers that later would need compatibility
layers forever.

## What Changes

- **Name everywhere users see it.**
  - App name, window title, installer and bundle names (`HiveTeX_x.y.z_…`), release names, emails.
  - UI text, README and docs, CLI and Make output.
  - The footer source link.
- **Code identifiers.**
  - npm scope `@p2platex/*` → `@hivetex/*`.
  - Root package `hivetex`.
  - Rust crate `hivetex-desktop` / lib `hivetex_desktop_lib`.
  - Environment variables:
    - `P2PLATEX_API_BASE` → `HIVETEX_API_BASE` (GitHub variable too);
    - test and e2e variables (`HIVETEX_TEST_PICK_DIR`, `HIVETEX_APP`, `HIVETEX_DRIVER_PORT`);
    - `HIVETEX_DEV_STACK`.
- **Desktop identity.**
  - Bundle identifier `app.hivetex.desktop`.
  - Keychain service `app.hivetex.desktop`, migrating entries from the old service on first use.
  - Updater endpoint unchanged (already HiveTeX).
- **On-device data, migrated once on first start** so nothing is lost:
  - IndexedDB `p2platex-device`, `p2platex-locations` and `p2platex-project-<id>` → `hivetex-…`;
  - localStorage `p2platex.*` → `hivetex.*`.
- **Folder and repository files.** `.hivetex.json` / `.hivetexignore` are written. The old `.p2platex.json` /
  `.p2platexignore` are still read, and replaced on the next write.
- **GitHub backup.**
  - Branch `hivetex/backup`.
  - Commit trailer `X-HiveTeX-Backup: 1`. Commits with the old trailer still count as backups, so existing
    repositories don't look diverged.
  - The manifest is read from either marker name.
- **Protocol domains** (handshake, signaling auth, envelope, ticket type) become `hivetex/…`.
  - **BREAKING** for peer compatibility: a p2platex-era client cannot connect to a HiveTeX-era peer or server.
  - Acceptable now, because no released client exists. The server and web app are redeployed together, and the
    draft releases v0.1.0 and v0.1.1 are replaced by a new release.

## Capabilities

### New Capabilities

- `product-identity`: the product name used everywhere, and the one-time migration of on-device data and folder
  files from the previous name.

### Modified Capabilities

- `project-locations`: the folder marker is `.hivetex.json` (old name still recognised).
- `latex-workspace`: the mirror ignores the new marker and the ignore file (`.hivetexignore`), in both old and new
  names.
- `github-backup`: the divergence branch is `hivetex/backup`.

## Impact

- **Code:**
  - every package (`package.json` names, imports, tsconfig paths);
  - `apps/desktop/src-tauri` (Cargo, `tauri.conf.json`, `secrets.rs`);
  - `apps/web` (storage names, UI text);
  - `packages/protocol`, `packages/crypto`, `packages/github`, `packages/sync`;
  - `server` (emails);
  - `scripts`, `Makefile`, workflows, `docker`, `vercel.json`;
  - `pnpm-lock.yaml` regenerated.
- **Docs:** README, `docs/*`, `TODO_CI.md`, main specs where they name files or branches.
- **Ops:**
  - GitHub variable `HIVETEX_API_BASE` (set by `make setup`; the old one removed);
  - redeploy `hivetex.vercel.app`;
  - delete the v0.1.0 and v0.1.1 drafts and tag v0.2.0 after this lands.
