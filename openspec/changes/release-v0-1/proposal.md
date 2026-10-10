# Proposal

## Why

The product described in `CORE_IDEA.md` works end to end in tests, but nobody outside this machine can try it yet. A
readiness review for a first v0.1 found that:

- the release workflow has never run;
- it would fail at the updater-signing step, because the signing key is not a GitHub secret;
- the Linux AppImage would fail on Ubuntu 24.04 runners (known linuxdeploy `strip` and FUSE problems);
- macOS builds would be reported as "damaged" on Apple Silicon (unsigned);
- the updater and source links point to a repository that does not exist (`p2platex/p2platex`);
- a desktop install with no built-in server URL cannot be pointed at a server before signing in;
- nothing documents, in a few simple steps, how to deploy the free control plane and publish installers.

## What Changes

- **Release builds that work on GitHub.** Installers for Windows (NSIS `.exe`, `.msi`), macOS (universal `.dmg`) and
  Linux (`.AppImage`, `.deb`) are built on pinned runners, with the AppImage fixes and macOS ad-hoc signing. Updater
  artifacts are signed with the repository's key and attached to a draft GitHub Release when a `v*` tag is pushed.
- **Dry-run builds.** A manual run of the Desktop workflow builds the installers on all three systems and uploads them as
  workflow artifacts without creating a release. If the signing secret is missing, updater artifacts are skipped so the
  build still completes.
- **Consistent versioning.** The project is set to `0.1.0`, a helper sets the version everywhere at once, and the release
  job refuses a tag that does not match the version in the sources.
- **Correct links.** The updater endpoint and the "source code" link derive from the real repository
  (`federicocunico/p2platex`).
- **Server choice before sign-in (desktop).** The sign-in screen of the desktop app shows the server the app talks to and
  lets the user change it. This is required when an installer was built without a default server.
- **Setup guide and helper script.** The README gets a short "Release v0.1 and test with others" guide: create the free
  services, set environment variables, deploy, set GitHub secrets and variables, tag, install, test. Each step has a
  few sentences and the exact commands. A script generates the ticket-signing keys and prints the `vercel env` /
  `gh secret` commands to run.

## Capabilities

### New Capabilities

- `release-distribution`: building, signing and publishing the desktop installers and the web app for a release, how
  testers obtain and point them at a server, and the documented setup that lets a maintainer stand up a free deployment.

### Modified Capabilities

(none)

## Impact

- `.github/workflows/desktop.yml`: release job (pinned runners, AppImage environment, version check, signing), and a
  dry-run mode with artifact upload.
- `apps/desktop/src-tauri/tauri.conf.json`: version `0.1.0`, updater endpoint, macOS `signingIdentity: "-"`.
- Version fields in `Cargo.toml` and `package.json` files.
- `apps/web`: server URL field on the desktop sign-in screen, and a source link that follows the repository.
- `scripts/`: secrets generator, version bump.
- `README.md`, `docs/deployment.md`, `TODO_CI.md`.
- Accounts and secrets the maintainer must create are documented, not automated: Vercel, Neon, Upstash, Gmail App
  Password, optional Cloudflare TURN, GitHub secrets.
