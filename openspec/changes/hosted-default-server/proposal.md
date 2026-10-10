# Proposal

## Why

HiveTeX is meant to work as a LaTeX IDE out of the box: install the Windows `setup.exe` (or the macOS/Linux
packages), sign in, and collaborate. Compilation is shared, so a member without a LaTeX installation can rely on peers.
AI agents work on project folders. Today:

- **The default server is not part of the app.** It is baked in only when the CI variable is set, and a fork or local
  build gets no server at all. Changing the server is possible (sign-in screen, Account), but there is no "back to
  default".
- **`make dev` needs a local stack.** It runs a local API with an embedded database plus the web UI. Developing the UI
  against the real deployment needs manual setup. The hosted server also rejects the dev origin
  (`http://localhost:1420`), deliberately.
- **"Use peers" is only implicit.** A device without LaTeX relies on peers automatically, and a device with LaTeX can
  opt out of compiling for others. But there is no explicit choice to say "never compile here, use my peers", nor
  "compile only on this device".

## What Changes

- **Default server in the product.** `https://hivetex.vercel.app` is the built-in default of the desktop app.
  - A build can override it (the CI variable for forks or on-premise builds).
  - Users can change it on the sign-in screen or in Account, and *Use the default server* returns to it.
  - The web app keeps using its own origin.
- **`make dev`** starts the desktop app with hot reload, talking to `hivetex.vercel.app`.
  - The dev server proxies `/api` (HTTP and WebSocket) to the chosen server, so the hosted server's origin checks are
    unchanged.
  - `make dev SERVER=https://…` targets another deployment.
  - `make dev-local` keeps today's all-local mode (embedded API + web UI).
- **Compiler choice per device** (Settings → Compiler):
  - **Automatic**: today's behaviour, with the existing "compile for others" option.
  - **Use peers**: this device never compiles; no TeX is needed, and the in-browser engine is not downloaded.
  - **This device only**: compile locally after edits; results are not shared, and this device does not compile for
    others.

  The workspace status bar shows the mode and who compiles. In *Use peers*, when no peer can compile, it says so and
  suggests the other modes.
- **No Inno Setup.** The release already produces a Tauri NSIS `setup.exe` with Start-menu entry, uninstaller and
  auto-update support, so the Windows installer stays as it is.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-distribution`: the desktop app ships with the hosted server as its default, overridable per build and per
  device, with a way back to the default.
- `local-dev-environment`: `make dev` develops the desktop UI against the hosted (or a chosen) server; the all-local
  mode moves to `make dev-local`.
- `distributed-compilation`: an explicit per-device compiler preference (Automatic / Use peers / This device only).

## Impact

- **`apps/web`:**
  - `lib/api.ts`: default server, dev proxy base, reset;
  - `components/ServerChoice.svelte` and `views/Account.svelte`: *Use the default server*;
  - `lib/session.svelte.ts`: compile modes and election eligibility;
  - Settings UI and the status bar;
  - `vite.config.ts`: proxy target from an environment variable, with Origin rewriting.
- **`Makefile`:** `dev`, `dev-local`; `apps/desktop` scripts.
- **CI:** the release still passes the variable (now an override, not a requirement).
- **Docs:** README development table, `docs/deployment.md`, `docs/compilation.md`.
- **Depends on `rename-to-hivetex`,** which is applied first (variable and storage names).
