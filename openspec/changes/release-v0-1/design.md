# Design

## Context

- **Desktop workflow.** `.github/workflows/desktop.yml` has a `release` job (tag `v*` only) using `tauri-action@v0` on
  `windows-latest` / `macos-latest` (universal) / `ubuntu-latest`. It has never run.
- **Updater.** `tauri.conf.json` sets `createUpdaterArtifacts: true` and an updater public key. The matching private key
  is at `~/.tauri/p2platex.key` on the maintainer's machine, with an empty password. A local Windows `tauri build` with
  it produced signed MSI and NSIS installers. On GitHub, the secret is missing, so the bundler would stop with "A public
  key has been found, but no private key".
- **Known runner problems.**
  - On Ubuntu 24.04, linuxdeploy's bundled `strip` fails on `.relr.dyn` sections (fix: `NO_STRIP=true`).
  - linuxdeploy is itself an AppImage and needs FUSE (fix: `libfuse2`, or `APPIMAGE_EXTRACT_AND_RUN=1`).
  - `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19.
  - Unsigned Apple Silicon apps are reported as "damaged"; ad-hoc signing (`signingIdentity: "-"`) restores the normal
    "Open Anyway" flow.
- **Server URL.** The desktop app reads it from local storage (`serverUrl`) or the build-time `VITE_API_BASE`. It can
  only be changed on the Account page, after sign-in.
- **Repository links.** The repository is `federicocunico/p2platex`. The updater endpoint and the web footer link point
  to `p2platex/p2platex`, which does not exist.

## Goals / Non-Goals

**Goals:**
- A tag produces a draft release with installers for all three systems and a signed update manifest.
- A manual run produces the same installers as artifacts, as a check that needs no secrets.
- A fresh desktop install can be pointed at any deployment before signing in.
- A maintainer can deploy and release by following the README.

**Non-Goals:**
- Paid code signing or notarization (Apple Developer ID, Windows Authenticode). These are documented as optional.
- Automating account creation on Vercel, Neon, Upstash, Gmail or Cloudflare.
- Mobile builds, or a Linux build for ARM.

## Decisions

### D1. One `build` job for tags and manual runs
`release` becomes `build`, which runs on tag pushes and on `workflow_dispatch`. Matrix:

| Runner | `args` |
|---|---|
| `windows-2025` | |
| `macos-15` | `--target universal-apple-darwin` |
| `ubuntu-24.04` | |

Steps:
1. **Version check (tags):** `v${tauri.conf.json version}` must equal the tag, otherwise fail and print both.
2. **Signing:** if `TAURI_SIGNING_PRIVATE_KEY` is empty, a tag run fails with "set the TAURI_SIGNING_PRIVATE_KEY
   secret". A manual run adds `--config '{"bundle":{"createUpdaterArtifacts":false}}'` instead.
3. **Linux:** `NO_STRIP=true` and `APPIMAGE_EXTRACT_AND_RUN=1`, and `libfuse2` is installed.
4. **Build:** `tauri-action`. On tags it also gets `tagName`, `releaseName` and `releaseDraft: true`. On manual runs it
   gets no tag, so it only builds, and `actions/upload-artifact` uploads `src-tauri/target/**/release/bundle/**`.

Alternative considered: a separate dry-run workflow. Rejected, because the steps would drift from the real release.

### D2. Repository-derived URLs
- `tauri.conf.json` commits the real endpoint
  (`https://github.com/federicocunico/p2platex/releases/latest/download/latest.json`). The build passes
  `${{ github.repository }}` through `--config`, so a fork releases to itself.
- The web footer uses `VITE_SOURCE_URL`. It defaults to the real repository; Vercel builds can set it from the
  repository variables.

### D3. macOS ad-hoc signing
`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`. When `APPLE_CERTIFICATE` and `APPLE_SIGNING_IDENTITY` secrets
exist, `tauri-action` imports them and the environment identity takes precedence, so real signing remains possible.

### D4. Versioning
- `scripts/set-version.mjs <x.y.z>` writes the version to:
  - `tauri.conf.json`;
  - `src-tauri/Cargo.toml` (`[package]`);
  - the `p2platex-desktop` entry of `Cargo.lock`;
  - the `package.json` of the root, `apps/web` and `apps/desktop`.
- `make version VERSION=x.y.z` calls the script.
- `make release VERSION=x.y.z CONFIRM=1` checks that the tree is clean and the versions match, then creates and pushes
  tag `vx.y.z`.
- The repository is set to `0.1.0`. The MSI format requires a numeric `x.y.z`, so pre-release suffixes are not used.

### D5. Server choice on the sign-in screen (desktop)
- URL validation moves from `Account.svelte` to `lib/api.ts` as `setServerUrl(input)`. It accepts an `https:` origin,
  or `http://localhost`, stores the origin under `serverUrl`, and throws a readable error otherwise.
- On desktop, `Auth.svelte` (sign-in and register modes) shows "Server: <origin or 'not set'> · Change". Changing it
  validates, saves and reloads, so every module picks up the new base.
- When no server is set at all, the field is shown open, with a hint.
- The web app never shows the field: it always uses its own origin.

### D6. Secrets script
`scripts/gen-secrets.mjs` (Node built-ins only):
- generates an Ed25519 key pair;
- prints `TICKET_SIGNING_JWK`, `TICKET_PUBLIC_JWKS` and `TICKET_KID=k1`;
- prints ready-to-paste `vercel env add …` commands (production and preview) and the
  `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/p2platex.key` command.

It writes nothing to disk. `make secrets` runs it.

### D7. README guide
A "Release v0.1 and test with others" section, about 10 numbered steps, each with 1–3 sentences and commands:
1. accounts;
2. `vercel link` and the Marketplace integrations;
3. secrets;
4. SMTP;
5. optional TURN;
6. deploy + migrate;
7. admin;
8. GitHub secrets and variables;
9. tag;
10. install and test.

`docs/deployment.md` keeps the details; the README links to it.

## Risks / Trade-offs

- **Vercel WebSockets are a public beta** (Fluid Compute). If they misbehave, the documented fallback is the Docker stack
  on any VPS (`make up`) behind HTTPS.
- **Unsigned Windows installers trigger SmartScreen** ("More info → Run anyway"). This is documented for testers.
- **The macOS universal build is slow** (two targets). Acceptable for releases.
- **Pinned runner images will need bumping when GitHub retires them.** That is a deliberate, visible change instead of
  a silent one.
- **Without TURN, peers behind strict NATs may not connect across networks.** The guide recommends the free Cloudflare
  TURN tier for cross-network tests.
