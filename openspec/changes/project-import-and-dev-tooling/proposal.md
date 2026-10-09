# Proposal

## Why

People arrive with existing work: an Overleaf project downloaded as a zip, an arXiv source tarball, or a folder of
LaTeX sources on disk. Today the app has only a minimal zip import (on project creation, or by dropping a `.zip` into
the tree behind a `confirm()`), which picks the main file naively, decodes every text file as UTF-8, silently overwrites
existing files, cannot take folders or tarballs, and gives no progress or summary. Moving a real paper in is the first
thing a new user does, so it has to be reliable.

Separately, running and shipping the project requires remembering a dozen `pnpm`/`playwright`/`cargo`/`vercel`
commands spread across the README and `docs/deployment.md`, and there is no way to exercise the *production* code path
(Neon HTTP driver, Upstash REST, Vercel function wrapper) locally — only the PGlite/in-memory dev server. A single
Makefile plus a Docker Compose stack makes local testing of every component, and deploying the Vercel part, one
command each.

## What Changes

- **Project import pipeline** (web + desktop, client-side only — sources never touch the control plane):
  - Accept `.zip` (Overleaf, GitHub, generic), `.tar.gz` / `.tgz` / `.tar` (arXiv sources), whole folders
    (folder picker and drag-and-drop of directories), and loose files.
  - Usable both when creating a project and inside an existing project (menu action "Import…").
  - Inside an existing project, a preview dialog lists added / changed / unchanged files and lets the user choose
    *merge* (overwrite conflicting files) or *keep existing* per conflict, or *replace all*; nothing is written until
    confirmed. Replaces the current `confirm()`.
  - Main-file detection based on content (`\documentclass` + `\begin{document}`), with Overleaf/arXiv conventions,
    `latexmkrc` hints, and the user able to override in the preview.
  - Engine hint: detect `fontspec`/`unicode-math`/`polyglossia` (→ XeLaTeX) or `% !TEX program` magic comments, and set
    the project compiler accordingly when the project has none.
  - Robust text/binary classification and non-UTF-8 decoding (Latin-1 / Windows-1252 fallback with a notice).
  - Filters build artifacts and OS junk (`.aux`, `.log`, `.synctex.gz`, `.fdb_latexmk`, `__MACOSX/`, `.DS_Store`,
    `.git/`, …) consistently with the folder-mirror ignore list; keeps the existing traversal / zip-bomb defences and
    extends them to tar and folder inputs.
  - Progress indicator and final summary (files imported, skipped and why), applied in batched transactions so peers
    receive a coherent tree.
- **Uploads**: upload/drop inside the tree reuses the same pipeline (conflict prompt instead of silent overwrite,
  folder upload, per-file size limit with a clear error).
- **Developer tooling**:
  - Root `Makefile` with documented targets: `help`, `install`, `dev`, `build`, `lint`, `test`, `e2e`, `desktop-dev`,
    `desktop-test`, `up` / `down` / `logs` / `reset` (Docker Compose), `test-stack`, `migrate-local`,
    `deploy-preview`, `deploy-prod`, `migrate-prod`, `env-pull`, `seed-admin`, `clean`.
  - `docker-compose.yml` that runs the full stack locally with production parity: Postgres + Neon HTTP proxy, Redis +
    Upstash-compatible REST proxy, Mailpit (SMTP catcher), the API built from `server/` using the *production* deps
    path, and the web app; optional profiles for a TURN server (coturn) and a self-hosted TeX Live file server for the
    in-browser engine.
  - Small, opt-in env overrides in the server so the production deps can target those local emulators
    (`NEON_HTTP_ENDPOINT`, SMTP host/port override) — no behavior change when unset.
  - Docs: README "Development" section and `docs/deployment.md` point to the Make targets; new `docs/local-stack.md`.

## Capabilities

### New Capabilities
- `project-import`: bringing existing LaTeX sources (archives, folders, files) into a new or existing project —
  accepted formats, safety limits, main-file and engine detection, encoding, conflict handling, progress and summary.
- `local-dev-environment`: the developer-facing command surface (Make targets) and the containerized local stack that
  reproduces the production control-plane path, plus the deploy targets for Vercel.

### Modified Capabilities
<!-- None in openspec/specs/: the bootstrap change (which defines latex-workspace "Import" and "File tree operations")
     is not archived yet. project-import refines those requirements; see design.md "Relationship to bootstrap specs". -->

## Impact

- **Web app**: `apps/web/src/lib/zip.ts` → new `apps/web/src/lib/import/` module (archive readers, classifier,
  decoder, detector, planner); `Projects.svelte` (create-from-archive/folder), `Workspace.svelte` + `FileTree.svelte`
  (Import… action, folder drop, conflict preview dialog), `session.svelte.ts` (`addFile` → batched apply).
- **Sync**: possibly a batch/transaction helper on `ProjectModel` for multi-file apply (`packages/sync`).
- **Desktop**: native folder import via existing Tauri dialog/fs plugins; no Rust changes expected beyond capability
  permissions if a read-dir command is missing.
- **Server**: `server/src/db/client.ts`, `server/src/mail.ts`, `server/src/production.ts` gain optional local-emulator
  overrides; new `server/Dockerfile` (or root `docker/`), no API or schema change.
- **Repo root**: `Makefile`, `docker-compose.yml`, `docker/` assets, `.env.docker` example, docs updates.
- **Dependencies**: none new at runtime for import (fflate already present; tar reader is small and in-house);
  Docker images are dev-only. GNU Make required on the dev machine (on Windows via Git Bash / Scoop / Chocolatey).
- **Privacy**: unchanged — import runs entirely on the client; nothing is uploaded to the control plane.
