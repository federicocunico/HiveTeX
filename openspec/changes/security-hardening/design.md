# Design

## Context

Findings and motivation: `proposal.md`. Requirements: the delta specs in this change. State observed in the code:

- `tex.rs` runs `latexmk` in the per-project build directory (`base_command`: `openout_any=p`, `openin_any=p`,
  `shell_escape=f`), with `-latexoption=-no-shell-escape`; latexmk reads `latexmkrc`/`.latexmkrc` from the working
  directory unless `-norc` is given. All project files, including those names, are written to that directory.
- MiKTeX ignores `openin_any`: verified on MiKTeX 25.4 that `\input{C:/…/secret.tex}` is read and lands in the PDF.
  With `MIKTEX_CORE_ALLOWUNSAFEINPUTFILES=f` in the process environment the same input fails with "File not found".
- `server/src/github.ts`: `/start` stores `{userId, handoff, pub}` under a random `state`; `/callback` (unauthenticated
  GET) exchanges the code, seals the token to `pub` and parks it for `userId`. Nothing ties the completing browser to
  `userId`.
- `packages/github/src/agent.ts`: binding read from `model.meta`; `setBinding` checks the *local* role only. The
  owner-only copy lives in `projects.github_repo` (PATCH is owner-only).
- `connection.ts:onTicketRefresh` accepts any valid ticket with the same `pid/uid/dev/devE`; `mesh.ts` clears the
  stale mark when `ep >= maxEpoch` and never sets it again for a lower epoch.
- `lib.rs`: `mirror_bind(id, dir)` takes `dir` from JS; the web remembers the folder in `localStorage` and re-binds it
  on the next start.
- `/projects/join`: failure counters keyed by `slug` + user/IP only.
- `pipeline.ts`: `compile-request` → `run()` immediately for every request.
- `signal/hub.ts`: `auth` message verified by ticket signature only; presence returns other members' tickets.
- `blobs.ts:onChunk` adopts the peer-declared `total` (u32) and `doFetch` iterates over it.

## Goals / Non-Goals

**Goals:** close every finding with a regression test at the layer where it lives; no change for honest users except
one extra click-free round trip in signaling and GitHub linking routed through the web app.

**Non-Goals:** defending against a malicious *editor* rewriting document content (still trusted, per the bootstrap
design); sandboxing the TeX process at OS level (containers/AppContainer); moving tokens server-side.

## Decisions

### D1. latexmk rc files
Pass `-norc` to latexmk (disables system, user and project rc files; our flags already cover what we need) **and**
skip any file whose basename is `latexmkrc` or `.latexmkrc` when materializing the build directory (defense in depth
for latexmk builds that might ignore `-norc` in the future, and for the fallback path). Rejected: allow-listing rc
content (Perl, not parseable safely).

### D2. No reads outside the project (all distributions)
Two layers:
1. **Engine switches**: `base_command` sets `MIKTEX_CORE_ALLOWUNSAFEINPUTFILES=f` / `…OUTPUTFILES=f` (MiKTeX then refuses
   absolute and `../` paths, images included) next to `openin_any/openout_any=p`. Per-process environment keeps the
   user's global configuration untouched.
2. **Read verification (added during apply)**: the Desktop workflow showed that TeX Live 2026 (macOS BasicTeX)
   *reads* absolute paths despite `openin_any=p`, and the same was reproduced in a `texlive/texlive` container. Writes
   are still refused. So every compile runs with `-recorder`, and afterwards `verify_reads` checks the `.fls` (every
   file the engine opened) and the `.blg` (bibtex/biber data sources). Reads are allowed only from the build
   directory, the TeX installation (`kpsewhich -var-value` of the TEXMF* variables), or font files. If anything else
   was read, the PDF, SyncTeX and log are all withheld and replaced by a generic message without paths.
Rust tests cover absolute `\input`, `../` `\input`, absolute `\includegraphics` and an absolute bibliography, and run
in the Desktop workflow on Windows (MiKTeX), macOS (TeX Live 2026) and Linux (TeX Live).

### D3. GitHub OAuth completion bound to the signed-in user
`/callback` no longer exchanges the code. It redirects to the SPA at `#/github-continue?code=…&state=…` (fragment: never
sent to servers or in `Referer`). That route requires sign-in (normal login if needed) and calls
`POST /api/github/complete {code, state}` with the user's session (cookie on web, bearer on desktop-in-browser is not
available, so desktop users complete in their browser signed in to the web app). The server takes the state from KV
and completes only if `state.userId === session.user.id`; otherwise it fails without exchanging the code. The
existing sealed hand-off to the device key stays as is. A forwarded link therefore lands in the victim's browser and
session, where the user check fails, and the attacker never sees the code.
Alternatives: state cookie only (does not cover desktop, whose flow starts via API without browser cookies);
loopback redirect (GitHub App callback URL constraints, extra listener in the desktop app).

### D4. Backup binding authority
`BackupAgent` gets `authorizedRepo: () => string | null` (the owner-recorded `owner/repo@branch`). The session keeps it
fresh from `GET /projects/:id` at open and from the ticket endpoint (which now also returns `githubRepo`). The writer
pushes only when the meta binding equals the authorized value; otherwise status `binding-mismatch`. `bindings` set by
owners still write both (meta + PATCH), so honest flows are unchanged.

### D5. Ticket refresh monotonicity
`onTicketRefresh` rejects (closes the connection) a ticket with `ep < current.ep` or `iat < current.iat`.
`mesh.onTicketRefreshed` additionally marks the peer stale whenever `ep < maxEpoch`. Test: demote → refresh viewer
ticket → replay old editor ticket → updates from that peer are dropped / connection closed.

### D6. Native folder picking with a persisted allowlist
New Rust command `mirror_pick(title) -> Option<String>` opens the folder dialog (`tauri-plugin-dialog`), canonicalizes
the choice and appends it to `picked-folders.json` in the app data dir. `mirror_bind(id, dir)` only accepts a `dir`
whose canonical path is in that list (re-binding remembered folders keeps working). JS `pickFolder` is replaced by
`mirror_pick`; folder import uses it too. Rejected: binding inside the pick command only (breaks the remembered-folder
re-bind on startup).

### D7. Global join failure limit
Extra counters `joinfail:any:u:<uid>` and `joinfail:any:ip:<ip>` (20 per 15 min), checked with `peek` before work and
incremented on every failure, alongside the per-slug ones.

### D8. Compile-request throttling
`CompileLeader` keeps `lastRequestAt` per device; requests closer than 5 s apart from the same device are ignored.
When a run is triggered by a request and `computeStateHash` equals the last successful result's `stateHash`, the
leader re-broadcasts the last result instead of compiling.

### D9. Signaling key-possession proof
On WebSocket open the relay sends `{t:'challenge', nonce}` (32 random bytes). The client answers
`{t:'auth', ticket, sig}` with `sig = Ed25519(devKey, "p2platex/signal/v1\0" + pid + "\0" + dev + "\0" + nonce)`. The relay
verifies `sig` against `claims.devE` before subscribing or announcing presence. Clients that send `auth` before a
challenge are refused (protocol version bump).

### D10. Blob size bound
`MAX_BLOB_BYTES = 50 MiB` in `@p2platex/protocol` (same as the import limit). `onChunk` ignores chunks whose `total`
exceeds `ceil(MAX_BLOB_BYTES / BLOB_CHUNK_SIZE)` and bans that peer for that hash in the current fetch.

## Risks / Trade-offs

- [Desktop GitHub linking now needs the web app signed in, in the system browser] → the continue page offers sign-in
  and returns to the flow; documented in `docs/github-backup.md`.
- [Signaling protocol change breaks old clients] → no public release yet; web and desktop ship from the same commit.
- [`MIKTEX_*` variable names change in a future MiKTeX] → the cross-OS Rust test fails in CI, not silently in
  production.
- [Throttling a legitimate "Recompile" double-click] → 5 s window; the second click gets the same in-flight result.

## Migration Plan

Deploy server and clients together (signaling challenge). No data migration. Remembered desktop folders bound before
this change are not in the allowlist: the app asks the user to pick the folder again once (clear message).
