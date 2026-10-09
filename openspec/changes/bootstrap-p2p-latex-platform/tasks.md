# Tasks

## 1. Monorepo scaffolding

- [x] 1.1 Initialize git, pnpm workspace, Turborepo, TypeScript strict base config, Biome and Vitest; verify `pnpm install && pnpm turbo build lint test` succeeds on an empty workspace
- [x] 1.2 Create package skeletons (`packages/protocol`, `crypto`, `sync`, `compile`, `github`, `ui`) and `apps/web` (Vite + Svelte 5), `api/` (Hono), `apps/desktop` (Tauri 2 pointing at `apps/web` build); verify `pnpm turbo build` builds all and `pnpm tauri dev` opens the placeholder window
- [ ] 1.3 Add `vercel.json` (static output of `apps/web`, `/api/*` functions on Node.js, single region, security headers + CSP from design D15); verify `vercel build` locally produces static + function output and headers appear in `vercel dev` responses
- [ ] 1.4 Add AGPL-3.0-or-later LICENSE, README (architecture overview, Hobby non-commercial note, source link requirement) and CI workflow (build, lint, test, `pnpm audit`); verify CI passes on a pushed branch

## 2. Control plane foundation (Neon + Upstash)

- [ ] 2.1 Provision Neon and Upstash via Vercel Marketplace and document required env vars in `.env.example`; verify `vercel env pull` populates them
- [ ] 2.2 Define Drizzle schema (users, sessions, email_tokens, projects, memberships, bans, devices, github_links, audit_log) and first migration; verify migration applies to a fresh Neon branch and a schema test asserts unique constraints on `username_lc`, `email_lc`, `slug`
- [ ] 2.3 Implement Hono app skeleton with error handling (no internal details leaked), Valibot validation, request IDs, Origin/CSRF-header middleware and Upstash ratelimit middleware; verify unit tests for rejected cross-origin POST and 429 after limit

## 3. User accounts (spec: user-accounts)

- [ ] 3.1 Implement registration with username/email/password rules, argon2id hashing, HIBP range check with bundled fallback list; verify tests for success, taken username (case-insensitive), short and breached passwords, and that DB rows contain no plaintext
- [ ] 3.2 Implement sign-in, session issuance (web `__Host-` cookie, desktop bearer), 30-day inactivity expiry, sign-out and sign-out-everywhere; verify tests for generic error parity (unknown user vs wrong password, incl. timing dummy-hash path) and session revocation
- [ ] 3.3 Implement per-IP/per-account rate limits and 10-failures/15-min lockout; verify test that the 11th failed attempt is refused for 15 minutes
- [ ] 3.4 Implement `Mailer` interface with Gmail SMTP (nodemailer, app password) and a test double; verify an integration test sends through the double and a manual smoke send works with real credentials
- [ ] 3.5 Implement email verification and password reset (hashed single-use tokens, 24 h / 30 min expiry, neutral responses, sessions revoked on reset); verify tests for registered, unknown, unverified, expired and reused-link scenarios
- [ ] 3.6 Implement password change with current-password check and revocation of other sessions; verify test
- [ ] 3.7 Implement platform-admin role (seed CLI script, recent re-auth requirement), force password reset and audit log; verify tests that admin reset revokes sessions + writes audit entry and non-admin gets 403
- [ ] 3.8 Build account UI (register, sign in, forgot/reset, verify email, change password, admin user search + force reset) in `apps/web`; verify Playwright flow register → verify → sign out → reset → sign in
- [ ] 3.9 Document account/admin operations in `docs/accounts.md`; verify the documented admin seed command runs as written

## 4. Project access and tickets (spec: project-access)

- [ ] 4.1 Implement project creation with custom slug validation or 80-bit random ID, mandatory password unless disabled, owner membership; verify tests for available/taken/generated IDs
- [ ] 4.2 Implement join (ID + password, default role, generic errors, 5-failures/15-min limit, ban check); verify tests for each join scenario
- [ ] 4.3 Implement owner management: change role, remove/ban, default role, change slug, change/disable password, add owner, last-owner protection, delete project — each bumping `epoch` where access shrinks; verify authorization tests (non-owner 403, last owner rejected, old slug stops resolving)
- [ ] 4.4 Implement device registration (Ed25519 + X25519 public keys) and ticket issuance as EdDSA JWS with claims from design D11, `/api/keys` endpoint and `kid` rotation; verify tests that tickets expire ≤ 15 min, removed members cannot obtain tickets, and a tampered ticket fails verification in `packages/crypto`
- [ ] 4.5 Implement `packages/crypto`: device key generation/storage (WebCrypto non-extractable + `@noble/curves` fallback), ticket verification with pinned keys, E2E envelope (X25519 → HKDF → AES-GCM); verify unit tests incl. cross-implementation round trip
- [ ] 4.6 Build project list, create/join dialogs, share panel (copy ID) and owner settings (members, roles, default role, password, slug, delete); verify Playwright: owner creates, second user joins as viewer, owner promotes to editor
- [ ] 4.7 Document the permission model and revocation timing in `docs/permissions.md`; verify it matches spec scenarios by review checklist

## 5. Signaling and NAT traversal

- [ ] 5.1 Implement `/api/signal` WebSocket (ticket-authenticated) with Upstash Redis pub/sub routing by `(projectId, toDevice)`, presence hash with 90 s TTL, reconnect handling for the 300 s limit; verify integration test with two WS clients on different function instances (simulated) exchanging ciphertext
- [ ] 5.2 Implement `/api/turn` minting short-lived Cloudflare TURN credentials for members with rate limit, provider configurable via env; verify test that non-members get 403 and credentials have expiry
- [ ] 5.3 Implement client signaling module (connect-on-demand, E2E-encrypted SDP/ICE, gatekeeper election and keep-alive, mesh peer-exchange for introductions); verify unit tests for gatekeeper determinism and that server-visible payloads are ciphertext only

## 6. Peer sync engine (spec: peer-sync)

- [ ] 6.1 Implement `PeerTransport` over browser WebRTC with `sync` and `bulk` DataChannels, 16 KiB chunking and backpressure; verify test transferring 20 MB between two in-process peers without exceeding the buffer high-water mark
- [ ] 6.2 Implement peer authentication handshake (ticket + signature over both DTLS fingerprints + nonce) and epoch gossip with 60 s refresh grace; verify tests: valid peers connect, wrong-project ticket closed, swapped fingerprint rejected, stale-epoch peer dropped
- [ ] 6.3 Implement Yjs project model (root doc with fileId map, lazy per-file subdocs, settings/meta) and file operations (create/rename/move/delete); verify convergence tests for concurrent rename+edit and concurrent same-sentence edits across 3 simulated peers
- [ ] 6.4 Implement IndexedDB persistence (update log ≤ 250 ms batching, compaction, blob store) and history snapshots with restore-as-edit; verify tests: reload after simulated kill retains edits, restore is undoable
- [ ] 6.5 Implement Yjs sync + awareness over the mesh with gossip/seen-set for >8 peers and deflate for large batches; verify a 10-peer simulation converges and update latency < 1 s on loopback
- [ ] 6.6 Implement role filter (drop/never forward updates and blob announcements from viewer connections); verify test with a tampered viewer client whose updates never reach other peers
- [ ] 6.7 Implement content-addressed blob transfer (parallel chunk fetch from multiple peers, hash verification, retry on corrupt chunk); verify tests for 5 MB image and corrupt-chunk scenario
- [ ] 6.8 Implement offline/online lifecycle (reconnect, merge, "no peer online" state with GitHub bootstrap hook); verify Playwright with two browser contexts: offline edits on both sides merge after reconnect
- [ ] 6.9 Add a control-plane privacy test: run a full editing session against a local API and assert no document text, file names or blob bytes appear in DB rows, Redis keys/messages or logs
- [ ] 6.10 Document the wire protocol and sync model in `docs/protocol.md`; verify message type table matches `packages/protocol` exports via a test

## 7. Workspace UI (spec: latex-workspace)

- [ ] 7.1 Integrate CodeMirror 6 with y-codemirror.next, LaTeX/BibTeX highlighting, bracket matching, read-only mode for viewers, remote cursors with usernames; verify Playwright: cursor of user B visible to user A, viewer cannot type
- [ ] 7.2 Implement `\ref`/`\cite`/command completion from project labels and `.bib` entries, project-wide search/replace; verify unit tests for label/bib indexing and the `\cite{` → `knuth84` scenario
- [ ] 7.3 Implement file tree (create, upload via drag-drop, rename, move, delete; viewer browse/download only); verify Playwright for upload and rename syncing to a second client
- [ ] 7.4 Implement PDF preview with pdf.js in a worker (lazy-loaded), zoom/page navigation, stale indicator and "compiled by" label; verify Playwright that stale indicator appears after an edit and clears after a new PDF
- [ ] 7.5 Implement zip export/import (main file detection); verify round-trip test zip → project → zip yields identical files
- [ ] 7.6 Accessibility and layout pass (keyboard navigation, ≥1024 px workspace, phone-sized project list/settings); verify axe-core checks in Playwright report no serious violations
- [ ] 7.7 Measure and enforce bundle budgets (initial JS ≤ 250 KB gz; pdf.js and WASM engine lazy); verify a CI size-limit check

## 8. Distributed compilation (spec: distributed-compilation)

- [ ] 8.1 Implement capability record (engine kind, benchmark perf factor, power state, load, opt-out, engine support) and Lamport-stamped gossip; verify unit test that a power change propagates within 5 s in simulation
- [ ] 8.2 Implement deterministic leader election with hysteresis, 2 s heartbeats and 3-miss failover; verify simulation tests: desktop beats laptops, leader shutdown → new leader < 10 s, partition then reunion → single leader
- [ ] 8.3 Implement compile pipeline on leader (debounce 1.2 s / max 5 s, snapshot at state vector, single queued re-run, result distribution as blobs + diagnostics, last-good-PDF retention); verify integration test with a fake engine
- [ ] 8.4 Implement LaTeX log parser producing `{file, line, severity, message}` and inline diagnostics; verify fixture tests over real pdfTeX/XeTeX logs
- [ ] 8.5 Implement WASM engine adapter (SwiftLaTeX pdfTeX/XeTeX in Web Worker, on-demand package fetch from configurable server, Cache Storage caching, time limit); verify Playwright compiles the sample paper in the browser
- [ ] 8.6 Implement native engine in Tauri Rust: embedded Tectonic + system TeX detection via latexmk, persistent incremental workdir, shell-escape disabled, `openout_any=p`/`openin_any=p`, time and memory limits; verify Rust tests: sample compiles, `\write18` payload does not execute, infinite-loop doc aborts at the limit
- [ ] 8.7 Implement SyncTeX forward/reverse navigation using leader-produced data; verify Playwright double-click in PDF jumps to the right line
- [ ] 8.8 Implement engine/main-file selection, "Recompile" for all roles and "Compile locally" override; verify tests that viewer recompile request is honored and unsupported-engine peers are ineligible
- [ ] 8.9 Document the election and engine setup in `docs/compilation.md`; verify documented TeX detection steps on Windows, macOS and Linux CI runners

## 9. Desktop app and local folder mirror (spec: latex-workspace)

- [ ] 9.1 Lock down Tauri capabilities (no shell, fs scope = app data + bound folders), CSP, keychain storage of session token and device private keys; verify capability config test and that tokens are absent from app data files
- [ ] 9.2 Implement Rust `webrtc-rs` `PeerTransport` fallback over IPC and auto-selection when `RTCPeerConnection` is unavailable; verify a Linux CI e2e syncs desktop ↔ web
- [ ] 9.3 Implement folder binding, `notify` watcher with debounce, ignore defaults + `.p2platexignore`, disk→CRDT minimal-diff apply, CRDT→disk atomic writes, echo suppression, viewer revert; verify tests: external edit appears remotely, remote edit lands on disk < 1 s, `main.aux` ignored, viewer change reverted
- [ ] 9.4 Implement hardware/power probing feeding capability records; verify unit tests with mocked battery states
- [ ] 9.5 Set up signed builds and Tauri updater via GitHub Releases for Windows/macOS/Linux; verify CI produces installers for all three
- [ ] 9.6 Document using Claude Code/Codex/Cursor with the mirrored folder in `docs/local-ai-tools.md`; verify the walkthrough by editing a file with an external tool and observing sync

## 10. GitHub backup (spec: github-backup)

- [ ] 10.1 Register GitHub App (contents RW, metadata R) and implement `/api/github/callback` token exchange returning tokens to the client (web one-time code, desktop loopback) storing only `github_login`; verify test that no token is persisted server-side or logged
- [ ] 10.2 Implement `packages/github` client: local git blob SHA-1, changed-blob upload, tree with `base_tree`, commit, non-force ref update, divergence → `p2platex/backup`; verify tests against a mocked GitHub API including non-fast-forward case
- [ ] 10.3 Implement repo binding UI (new private repo / existing repo + branch, owners only) and backup status panel (last backup, commit link, errors); verify Playwright with mocked API
- [ ] 10.4 Implement backup policies (idle T, every N, min interval, manual), counters in root doc meta, optional PDF inclusion, contributor commit message; verify simulation tests for idle and change-count triggers
- [ ] 10.5 Implement single backup-writer election among token-holding devices (owners preferred) with takeover on token expiry; verify test that two owners never both push
- [ ] 10.6 Implement bootstrap/import from GitHub (new project or merge into existing) and wire it to the "no peer online" state; verify test importing a sample repo and later merging with a peer
- [ ] 10.7 Document GitHub App setup and backup behavior in `docs/github-backup.md`; verify setup steps against a fresh test App

## 11. End-to-end integration and release

- [ ] 11.1 Run full e2e on a Vercel preview: two web clients + one desktop client join a project, edit concurrently, go offline/online, desktop is elected leader, kill desktop → web leader takes over, viewer stays read-only, owner removes a member within ~1 min; verify all assertions pass
- [ ] 11.2 Run a security review (OWASP ASVS L2 checklist for auth/session/access control, CSP verification, dependency audit, ticket/handshake threat model); verify no high-severity findings remain open
- [ ] 11.3 Measure free-tier consumption over a 1-week beta (Vercel invocations, Upstash commands, Neon storage/compute) against design D9 budget; verify usage projected per month stays below 50 % of each free quota
- [ ] 11.4 Seed production admin, promote preview to production, publish desktop release; verify production smoke test (register, create, join, edit, compile)

## Workflow follow-up

- Archive the change with `/opsx:archive` after review and the release checks pass.
- Verify the archived specs under `openspec/specs/` contain the six new capabilities.
