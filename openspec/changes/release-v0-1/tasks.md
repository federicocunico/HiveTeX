# Tasks

## 1. Versioning and links

- [x] 1.1 `scripts/set-version.mjs` + `make version VERSION=x.y.z`. It updates `tauri.conf.json`, `Cargo.toml`
  `[package]`, the `p2platex-desktop` entry in `Cargo.lock`, and the root/web/desktop `package.json`. Set `0.1.0`;
  verify `cargo check` and that `git diff` shows only version fields.
- [x] 1.2 Updater endpoint and web source link point to `federicocunico/HiveTeX` (overridable at build time); verify
  with grep that no `p2platex/p2platex` link remains outside archived changes.
- [x] 1.3 macOS ad-hoc signing (`bundle.macOS.signingIdentity: "-"`); verify that the `tauri.conf.json` schema
  validates (`cargo check` / `tauri info`).

## 2. Desktop workflow

- [x] 2.1 Turn `release` into `build`: tag + `workflow_dispatch` triggers, pinned runners (`windows-2025`, `macos-15`,
  `ubuntu-24.04`), version check on tags, signing-secret check (fail on tags, skip updater artifacts on manual runs),
  Linux `NO_STRIP` / `APPIMAGE_EXTRACT_AND_RUN` / `libfuse2`, updater endpoint from `github.repository`, artifact upload
  on manual runs; verify `actionlint` (or a YAML parse) passes.
- [x] 2.2 `make release VERSION=x.y.z CONFIRM=1`: clean tree, versions match, then tag and push; verify a dry run
  without `CONFIRM` refuses and prints the commands.
- [x] 2.3 Manual run of the Desktop workflow; verify all three platforms build and upload installers (Windows exe/msi,
  macOS dmg, Linux AppImage/deb).

## 3. Server choice before sign-in

- [x] 3.1 `setServerUrl` in `lib/api.ts` (shared validation), used by Account; verify unit tests: https origin
  accepted, path stripped, `http://localhost` accepted, `ftp:` and garbage rejected.
- [x] 3.2 Desktop sign-in/register screens show the server, with Change; open by default when no server is set; never
  on the web; verify `svelte-check` and that the web e2e suite stays green.

## 4. Secrets helper and guide

- [x] 4.1 `scripts/gen-secrets.mjs` + `make secrets`: Ed25519 ticket keys, the `vercel env add` and `gh secret set`
  commands, no files written; verify the printed JWKs work together (a sign/verify round trip in a unit test or a
  script self-check).
- [x] 4.2 README "Release v0.1 and test with others" guide (accounts → Vercel/Neon/Upstash → secrets → SMTP → TURN →
  deploy + migrate → admin → GitHub secrets/variables → tag → install/test, with the first-launch notes for each OS);
  update `docs/deployment.md` and `TODO_CI.md`; verify every command and Make target named exists.

## 5. Release

- [ ] 5.1 Set the `TAURI_SIGNING_PRIVATE_KEY` repository secret from `~/.tauri/p2platex.key`, then push tag `v0.1.0`;
  verify a draft release "p2platex v0.1.0" exists with installers for all three platforms, plus `latest.json` and
  `.sig` files.
- [ ] 5.2 `make check`, CI and Desktop green on the final commit.
