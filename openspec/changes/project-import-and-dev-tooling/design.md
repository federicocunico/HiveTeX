# Design

## Context

Motivation: see `proposal.md` › Why. Requirements: `specs/project-import/spec.md`, `specs/local-dev-environment/spec.md`.

Current state observed in the code:

- `apps/web/src/lib/zip.ts` has `readZip` (fflate `unzipSync`, traversal checks, 50 MB/entry and 500 MB total limits,
  strips a shared top-level folder, skips `__MACOSX/` and `.DS_Store`) and `detectMain` (`main.tex`, else first
  top-level `.tex`).
- `Projects.svelte` hands a zip to `Workspace.svelte` via a module-level `pendingImport`; `Workspace.importZip` calls
  `session.addFile` per entry, then always overwrites the `main` setting.
- `FileTree.svelte` supports file picker and drop of *files* only (no directories). `Workspace.onUpload` writes each file
  with `session.addFile`, silently overwriting; a dropped `.zip` triggers `confirm()`.
- `session.addFile` (`apps/web/src/lib/session.svelte.ts`) classifies text by an extension regex + NUL check, decodes
  with `TextDecoder()` (UTF-8, replacement chars on invalid input), and for an existing text file applies
  `applyTextDiff` (good: keeps identity). Binary goes to the blob store via `addBinary`.
- `ProjectModel` (`packages/sync/src/model.ts`) keeps the file index in a root Y.Doc and each text file in its own
  subdoc; `restoreSnapshot` already does a "write many files" pass that we can learn from.
- The folder mirror has `DEFAULT_IGNORES` and `.p2platexignore` (`packages/sync/src/mirror.ts`) using the `ignore`
  package.
- Compiler choice is the `engine` key in `model.settings` (default `pdflatex` when unset).
- Server: `local.ts` (PGlite + in-memory KV/limiter/signal, console mailer) vs `production.ts` (Neon HTTP, Upstash
  REST, Gmail SMTP, `experimental_upgradeWebSocket`). `api/index.ts` wraps `createApp()` with `hono/vercel`.
  No Dockerfile, no Makefile. Playwright starts the PGlite server + Vite dev.
- Developer machine is Windows; CI is Ubuntu.

## Goals / Non-Goals

**Goals:**
- One import pipeline (`read → filter → classify/decode → plan → preview → apply`) used by every entry point.
- Nothing is written to the project until the input is fully read and validated and the user confirmed.
- A local stack that runs the *production* deps module against emulators, so bugs specific to Neon HTTP / Upstash REST /
  SMTP surface before deploying.
- Make targets thin enough that they never drift from `package.json` scripts (they call them).

**Non-Goals:**
- Importing directly from an Overleaf URL / Overleaf API or Overleaf Git bridge (requires credentials and server-side
  fetch; zip download covers the need).
- `.rar` / `.7z` support; streaming import of archives larger than 500 MB.
- Containerizing the Tauri desktop app (needs host GUI toolchain; stays `make desktop-dev`).
- Running Vercel's real function runtime in Docker; the API container runs the same Hono app via `@hono/node-server`
  with production deps. `vercel dev` remains available but is not the default.
- Reproducing Overleaf project settings not present in the zip (Overleaf's compiler choice is not exported).

## Decisions

### D1. Import module layout (`apps/web/src/lib/import/`)
Split `zip.ts` into small pure modules so they are unit-testable in Vitest without a DOM:
- `sources.ts` — turns a `File` (zip/tar/tgz), a `FileList`, `DataTransferItem[]` (via `webkitGetAsEntry` recursion) or a
  desktop folder path into a uniform async iterator of `{path, size, read(): Promise<Uint8Array>}` plus declared sizes.
- `zip.ts` / `tar.ts` — archive readers. Zip keeps fflate `unzipSync` with the `filter` size check (already proven).
  Tar is an in-house ~100-line ustar/pax reader over `gunzipSync` output (fflate), rejecting types other than `0`/`\0`
  (regular) and `5` (dir), which blocks symlinks/hardlinks/devices. Alternative: `tar-stream`/`js-untar` — rejected:
  Node stream deps or unmaintained; format subset we need is tiny.
- `filter.ts` — reuses `DEFAULT_IGNORES` from `@p2platex/sync` (export it from the package index if not already) plus
  import-only junk (`__MACOSX/`, `Thumbs.db`, `.svn/`). Same list as the mirror → one source of truth.
- `classify.ts` — text/binary decision (moves the regex out of `session.addFile`; adds `.Rnw`, `.ist`, `.clo`, `.lua`,
  `.bbl`, `.tikz`, `.pgf`, `.asy`, `.latexmkrc`/`latexmkrc`, `.gitignore`) and decoding: `new TextDecoder('utf-8',
  {fatal:true})`; on throw fall back to `TextDecoder('windows-1252')` and flag `converted`. Strip UTF-8 BOM.
- `detect.ts` — main file + engine detection (spec order). Reads only text entries already decoded; regexes are
  comment-aware (ignore lines starting with `%` except magic comments).
- `plan.ts` — given current project files (path → kind + content hash or text) and imported entries, produces
  `{added, changed, identical, skipped, converted}` and, for `replace`, `deleted`. Identity comparison: text by string
  equality, binary by blob hash (blob store already hashes).
- `apply.ts` — executes a confirmed plan against `ProjectSession` (see D3).

`session.addFile` keeps its signature but delegates to `classify` so loose uploads and imports agree.

### D2. Limits enforced before allocation
Zip: fflate's `filter` sees `originalSize` from the central directory before inflating (existing approach) and we add an
entry-count cap. Tar: sizes come from headers, checked as we walk; gzip total is bounded by checking accumulated output
size inside a streaming `Gunzip` (`fflate.Gunzip` with `ondata`) so a gzip bomb aborts early instead of after
`gunzipSync` allocates. Folders: sizes from `File.size` / Tauri metadata before reading. Declared-size lies in zips are
caught because fflate verifies sizes on inflate; we wrap and rethrow as "archive corrupt".

### D3. Coherent application to the CRDT
Read and decode everything into memory first (bounded by D2), compute the plan, show the preview; only after confirm:
1. Upload all binary blobs to the local blob store (content-addressed, idempotent — safe if we abort later).
2. For changed text files: `applyTextDiff` on the existing subdoc (identity preserved — spec *Overwrite preserves
   collaboration*).
3. For new files and deletions: a single `root.transact` that creates all index entries (text subdocs are created
   with their initial content in the same pass, mirroring `restoreSnapshot`), deletes `deleted`, and sets `main` /
   `engine` if decided. Peers receive the index change as one update.
Add `ProjectModel.applyBatch(ops)` in `packages/sync` to own step 3 rather than looping `createTextNow` from the UI.
Alternative: apply file-by-file as today — rejected: partial trees on peers and no clean failure semantics.

### D4. Preview dialog
New `ImportDialog.svelte` (modal, keyboard accessible, focus-trapped) shared by the creation flow and the workspace.
Shows grouped lists with counts, per-row overwrite/keep toggle for changed files, global "overwrite all / keep all",
"replace project contents" (danger style, requires a second click like the existing delete confirm), main-file select
(pre-filled by `detect`), and target folder (for drops onto a folder). For a brand-new/empty project the preview is
skipped unless detection is ambiguous (several root documents), in which case only the main-file picker is shown.
The `confirm()` for dropped zips is replaced by a two-button choice inside the same dialog ("Extract" / "Add as file").

### D5. Entry points and hand-off
Replace the module-level `pendingImport` File with a parsed `ImportBundle` kept in the same module variable (still not
persisted — avoids serializing large data into `sessionStorage`); creation form accepts archive or folder (a second
input with `webkitdirectory`). Workspace header gets "Import…" (editors only). `FileTree` drop handler walks
`DataTransferItem.webkitGetAsEntry()` to support folders; falls back to files when unavailable.
Desktop: the existing `@tauri-apps/plugin-dialog` opens a folder; reading uses the existing `tauri-fs.ts` helpers (check
they expose recursive read; if not, add a narrowly-scoped command reusing `mirror.rs` ignore logic).

### D6. Progress
`apply` and readers report `(done, total)` through a callback; the dialog shows a `<progress>` bar. Decoding and
inflating happen on the main thread for now (fflate is fast; 500 MB is the cap). If profiling shows jank above ~100 MB,
move readers to a Web Worker — the module split in D1 makes that a contained change.

### D7. Docker Compose topology (`docker-compose.yml`, `docker/`)
Services (default profile):
| service | image | role | host port |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | database | 5432 |
| `neon-proxy` | `ghcr.io/timowilhelm/local-neon-http-proxy` | Neon HTTP/WebSocket API over `postgres` | 4444 |
| `redis` | `redis:7-alpine` | KV / pub-sub | 6379 |
| `srh` | `hiett/serverless-redis-http` (digest-pinned) | Upstash REST commands over `redis` | — |
| `upstash` | node:22-alpine running `docker/upstash-shim.mjs` | Upstash REST front: forwards to `srh`, adds pub/sub streaming (`POST /subscribe/<ch>`, SSE) which SRH lacks and signaling needs | 8079 |
| `mailpit` | `axllent/mailpit` | SMTP catcher + web inbox | 8025 (UI), 1025 (SMTP) |
| `api` | built from `docker/api.Dockerfile` (node:22-alpine, pnpm, tsx) | runs migrations then `server/src/docker.ts` | 3001 (host) — never 3000, so Playwright cannot mistake it for the dev server |
| `web` | built from `docker/web.Dockerfile` | Vite build served by a tiny static server with `/api` proxy and the same security headers as `vercel.json` | 8080 |
Profiles: `turn` → `coturn/coturn` with static dev credentials; `texlive` → nginx serving a TeX Live tree in the
SwiftLaTeX layout (volume-mounted, documented as large) with web built using `VITE_TEXLIVE_URL`.
Alternatives: plain Postgres TCP via `pg` driver in Docker — rejected: wouldn't test the Neon HTTP path, which is the
point (spec *Production code path parity*). Running `vercel dev` in a container — rejected: needs Vercel login/link,
not hermetic.

### D8. Server overrides (opt-in, no production change)
- `server/src/docker.ts`: new entry that builds deps with the production factories and serves via `@hono/node-server`
  plus the same WebSocket upgrade wiring as `local.ts` (since `experimental_upgradeWebSocket` is Vercel-only). It reuses
  `productionDeps()` pieces; to make that possible `production.ts` exports a `productionDepsWith({ upgradeWebSocket,
  background })` and the Vercel entry keeps calling it with Vercel's implementations.
- `createNeonDb` honors `NEON_HTTP_ENDPOINT` by setting `neonConfig.fetchEndpoint` (and `useSecureWebSocket=false`,
  `wsProxy`) only when the var is set.
- Mailer: `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` override Gmail transport when set; `GMAIL_*` remain the production
  path. Mailpit needs no auth.
- Ticket keys: `docker.ts` generates an ephemeral Ed25519 key when `TICKET_SIGNING_JWK` is unset **and**
  `P2PLATEX_DEV_STACK=1`; production still fails fast on a missing key.
- Committed `docker/.env.stack` holds only dev defaults (passwords like `postgres`/`devtoken`), satisfying the
  *No secrets* requirement.

### D9. Makefile design
- GNU Make, `SHELL := bash` (Git Bash on Windows), `.ONESHELL` off, every target `.PHONY`, `help` as default target
  generated from `## description` comments (`grep`/`awk` — available in Git Bash).
- Recipes call `pnpm` scripts / `turbo`, `docker compose`, `cargo`, `npx vercel@latest` (no global Vercel CLI needed).
  A `require-%` helper checks a tool with `command -v` and prints install hints.
- Main targets: `install`, `dev` (server + web in parallel via `pnpm -r --parallel` or `turbo run dev`), `build`, `lint`,
  `typecheck` (svelte-check), `test`, `e2e`, `check` (all of the above, CI equivalent), `desktop-dev`, `desktop-test`,
  `desktop-build`, `up`/`down`/`logs`/`ps`/`reset` (with `PROFILES=` passthrough), `test-stack` (Playwright with
  `PLAYWRIGHT_BASE_URL=http://localhost:8080` and `SKIP_WEBSERVER=1`), `migrate-local`, `env-pull`, `deploy-preview`,
  `deploy-prod` (requires `CONFIRM=1`, runs `check` first), `migrate-prod`, `seed-admin ADMIN=…` (not `USER`: Make imports the login name from the environment), `clean`.
- `playwright.config.ts` learns `PLAYWRIGHT_BASE_URL` / `SKIP_WEBSERVER` (and the API URL used by `e2e/helpers.ts` for the
  dev mailbox → for the stack, a Mailpit API adapter in helpers).
- Turbo: add a non-cached persistent `dev` task in `turbo.json` if `make dev` uses turbo; read the installed turbo docs
  (`node_modules/turbo/docs`) first per AGENTS.md.

### D10. Relationship to bootstrap specs
`bootstrap-p2p-latex-platform` (unarchived) defines `latex-workspace` › *Import* and *File tree operations*. This change
defines the detailed behavior in a new `project-import` capability instead of MODIFIED deltas, because those
requirements are not yet in `openspec/specs/` (MODIFIED would have no base). After bootstrap is archived, its *Import*
requirement remains the high-level statement and `project-import` the detail; no conflict in behavior (bootstrap's zip
scenario — `main.tex` set as main — still holds).

### D11. Findings while building the stack (implementation notes)
- SRH has no Upstash pub/sub endpoint → the shim above (dependency-free RESP subscriber + SSE in Upstash's line format).
- `createUpstashSignalBackend.subscribe` resolved before the SSE subscription was live, so offers sent right after a
  device announced itself could be lost (production bug, invisible with the in-memory backend). It now waits for the
  `subscribe` confirmation (5 s cap).
- The stack runs real rate limits; `make test-stack` starts the API with `E2E_NO_LIMITS=1` (docker entry only).
- Import keeps `.bbl` files although the mirror ignores them: arXiv sources ship `.bbl` instead of running BibTeX.
- Known, out of scope: when the same device reconnects quickly (page reload), the old session's delayed cleanup
  (`removePresence` + `leave`) can land after the new `join`, dropping the fresh connection on peers. Needs
  per-connection session ids in the signaling protocol; makes `e2e/full-flow.spec.ts` flaky on the stack.

## Risks / Trade-offs

- [Community emulator images (Neon proxy, SRH) drift from real services] → pin image digests; keep `make e2e` (PGlite)
  as the fast path and run `test-stack` in CI only on a nightly/manual workflow.
- [Windows: GNU Make not installed by default] → README documents `scoop install make` / `choco install make`; all
  targets also map 1:1 to `pnpm` commands listed in `make help`.
- [Large imports block the main thread] → limits from D2; Worker offload is a contained follow-up (D6).
- [Windows-1252 fallback mis-decodes other legacy encodings (e.g. Latin-2)] → summary flags converted files so users
  can check; full charset detection is out of scope.
- [Tar reader is custom code handling untrusted input] → strict type whitelist, path checks shared with zip, fuzz-ish
  unit tests with malformed headers, truncated blocks and PAX long names.
- [Main-file heuristic wrong on multi-document repos] → user override in preview; ambiguous case always shows picker.
- [`replace` deletes peers' concurrent new files] → explicit danger confirmation; CRDT history/snapshots allow restore.

## Migration Plan

No data migration. Import changes are client-side and backward compatible (same CRDT model; new `applyBatch` produces
ordinary updates old clients understand). Server overrides are inert without env vars, so the Vercel deployment is
unaffected; deploy as usual (now via `make deploy-preview` → `make deploy-prod CONFIRM=1`). Rollback: revert the web
build; no persisted format changed.

## Open Questions

- Exact pinned versions/digests for the Neon HTTP proxy and SRH images (choose at implementation time, after checking
  they support the `@neondatabase/serverless` version in the lockfile).
- Whether to add a nightly GitHub Actions job for `make test-stack` (can be decided after the stack is stable).
