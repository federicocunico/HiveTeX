# Tasks

## 1. Mechanical rename

- [x] 1.1 Rename with a one-off script (design D1): npm scope, package names, crate/lib names, env vars, marker/ignore
  file names, prose; regenerate the lockfile; verify `pnpm install --frozen-lockfile`, `turbo build lint test`,
  `cargo check`, and that a case-insensitive `git grep` for the old name lists only the compatibility code and archived changes
- [x] 1.2 Desktop identity: `productName` HiveTeX, identifier `app.hivetex.desktop`, window title; verify `tauri build`
  produces `HiveTeX_<version>_x64-setup.exe`

## 2. Compatibility and migration

- [x] 2.1 Web storage migration (D2): localStorage prefix and IndexedDB databases copied once; verify unit tests with
  fake-indexeddb (keys, project store, locations migrated; second start does nothing; failure keeps old data)
- [x] 2.2 Desktop: keychain entries from the old service; picked-folders allowlist from the old app-data folder; verify
  Rust tests (secret found under old service is moved; allowlist copied once)
- [x] 2.3 Folder and backup compatibility (D4): legacy marker and ignore file read, marker replaced on write, legacy
  backup trailer and manifest accepted; verify sync and github tests for each case

## 3. Protocol and ops

- [x] 3.1 Protocol domains renamed (D5); verify the server p2p tests and e2e suite pass with the new domains
- [x] 3.2 Docs, README, `TODO_CI.md`, main spec texts naming files/branches; `make setup` sets `HIVETEX_API_BASE` and
  removes the old variable; verify links and commands
- [x] 3.3 Redeploy hivetex.vercel.app (`make setup`), CI and Desktop green; verify `/api/health`, sign-in and signaling
  on the new deployment
