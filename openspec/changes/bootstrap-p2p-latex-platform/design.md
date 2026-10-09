# Design

## Context

Greenfield repository (only `CORE_IDEA.md` and OpenSpec scaffolding exist). Motivation is in `proposal.md`; behavior is in `specs/*/spec.md`. Hard constraints that shape everything below:

- **$0 operating cost**: the control plane runs on Vercel Hobby (Fluid Compute, Node.js functions, 300 s max duration, single region, non-commercial use) and free tiers of Marketplace stores.
- **Content privacy**: sources, assets, PDFs and edit operations never reach the control plane (spec `peer-sync` › *Content never touches the control plane*).
- **Two clients, one codebase**: browser (web) and Tauri 2 desktop must interoperate in one project.
- **Reference projects**: Overleaf (AGPL-3.0, React + CodeMirror 6, server-side TeX) and Oleafly (AGPL-3.0, Tauri + Vite + TypeScript + CodeMirror + Tectonic, Git-based, no CRDT). Oleafly's desktop/compile stack is close to ours; neither has P2P sync.

## Goals / Non-Goals

**Goals:**
- Sub-second edit propagation between connected peers; zero-latency local editing.
- Control-plane traffic proportional to *joins and ticket refreshes*, not to edits.
- Fast incremental compiles on the best device; small client bundles with lazy-loaded heavy parts (PDF renderer, WASM TeX).
- A security model where a compromised or curious control plane cannot read content or silently MITM peers.

**Non-Goals:**
- Server-side compilation or server-side storage of project content (even encrypted) — rejected by the user in favor of "GitHub fallback".
- Built-in AI assistant (AI use is via local tools on the mirrored folder).
- Mobile apps; rich-text/visual editor; Typst/Markdown engines (possible later).
- Defending against a malicious *editor* (editors are trusted collaborators; only viewer→write is enforced cryptographically).
- 2FA/TOTP and OAuth sign-in (accounts are username+password per user decision; can be added later).
- Encryption at rest of local device storage beyond what the OS/browser provides.

## Decisions

### D1. Monorepo layout and tooling
pnpm workspaces + Turborepo, TypeScript strict, Vitest, Playwright for e2e, Biome for lint/format.

```
apps/web        Vite SPA (also the Tauri frontend)          → Vercel static
apps/desktop    Tauri 2 shell (src-tauri: Rust services)
api/            Vercel Functions (Hono on Node.js)           → same Vercel project
packages/protocol   wire formats, ticket claims, message codecs (zero deps)
packages/crypto     device keys, ticket verify, E2E signaling envelopes
packages/sync       Yjs model, persistence, mesh, role filter, blob store
packages/compile    election, capability probe, engine adapters (wasm/native bridge)
packages/github     backup/import client (Git Data API)
packages/ui         Svelte components (editor, file tree, PDF view)
```
One Vercel project serves `apps/web` static output plus `/api/*` functions, so the web app and API share an origin (no CORS, `__Host-` cookies work). *Alternative*: separate API project — rejected (CORS, cookie complexity, two deployments).

### D2. Frontend: Svelte 5 + Vite, CodeMirror 6, pdf.js
The heavy parts (CodeMirror 6, pdf.js, the WASM engine) are framework-agnostic, so the UI framework only drives chrome; Svelte 5 compiles to small, fine-grained reactive code (smaller bundles, no VDOM). pdf.js and the WASM engine are lazy-loaded in workers. LaTeX language support: `codemirror-lang-latex`-style Lezer grammar, with pieces adapted from Overleaf's CM6 LaTeX mode where useful (see D16).
*Alternatives*: React (largest ecosystem, Overleaf UI is React — but tightly coupled to Overleaf's backend, and React's runtime is heavier); SolidJS (similar perf, smaller ecosystem).

### D3. Desktop: Tauri 2 with Rust services
Rust side provides only what the webview can't do well: native compile (D12), folder watcher/mirror (D13), OS keychain (`keyring`), hardware/power probing (`sysinfo`, `battery`), and a WebRTC fallback. Sync, crypto and UI logic stay in shared TypeScript.
**WebRTC in webviews**: WebView2 (Windows) and WKWebView (macOS) support `RTCPeerConnection`; WebKitGTK on Linux may not (depends on distro build). `packages/sync` talks to an abstract `PeerTransport`; on Linux (or whenever `RTCPeerConnection` is missing) the desktop uses a Rust `webrtc-rs` implementation exposed over Tauri IPC. Tauri capabilities are locked down: no shell plugin, fs scope limited to app data + user-bound mirror folders, strict CSP.
*Alternative*: Electron (bundled Chromium, guaranteed WebRTC) — rejected for 10× install size and RAM.

### D4. Document model: Yjs with per-file subdocuments
- **Root doc** per project: `files: Y.Map<fileId, {path, kind, hash?, mtime}>` (stable random `fileId`, so rename/move = one field update, never a delete+create → no duplicates), `settings: Y.Map` (main file, engine, backup policy), `meta`.
- **Text files**: one Yjs subdoc per file (`Y.Text`), loaded lazily — opening a 200-file thesis does not load every chapter into memory or sync them all up front.
- **Binary files**: only the SHA-256 content hash lives in the CRDT; bytes live in a content-addressed blob store (D6).
- Character-level CRDT merging is a strict superset of "paragraph-by-paragraph" merging; concurrent edits never produce conflict copies.
*Alternatives*: Automerge 2 (heavier WASM, fewer editor bindings); Loro (excellent Rust CRDT with movable tree, faster; less mature bindings/ecosystem today — revisit later, `packages/sync` keeps the CRDT behind an interface); Git-style merge like Oleafly (not real-time, needs conflict resolution UI).

### D5. Local persistence
IndexedDB in both clients (Tauri webview included): per-doc append-only update log, compacted to a single `encodeStateAsUpdate` snapshot after 500 updates or on idle; writes batched every ≤ 250 ms (meets "edits > 1 s before a kill survive"). Blob store in a separate object store keyed by hash. History snapshots (`peer-sync` › *Local history*) are periodic compacted snapshots (every 10 min of activity, thinned exponentially), restored by applying a diff as a normal edit.

### D6. P2P transport and wire protocol
- **WebRTC DataChannels**, two per connection: `sync` (reliable, ordered: Yjs sync protocol, awareness, election/control) and `bulk` (reliable, unordered-by-stream: blob chunks, PDFs). Chunk size 16 KiB (safe across browsers), backpressure via `bufferedAmountLowThreshold` (1 MiB high-water).
- Binary encoding with `lib0` varints; message = `[type u8][payload]`. Text update batches > 1 KiB are deflated with the native `CompressionStream('deflate-raw')`; already-compressed blobs (PNG/JPEG/PDF) are not.
- **Topology**: full mesh up to 8 peers; above that each peer keeps ~6 connections (lowest RTT + random) and gossips updates. Yjs updates are idempotent, so flooding with a seen-set (hash of update) is safe.
- **Blobs**: request by hash from any peer advertising it, parallel chunk requests across peers, verify full-hash before commit, retry on mismatch.

### D7. Signaling: short-lived WebSockets on Vercel + Upstash Redis fan-out, E2E-encrypted
Vercel Functions support WebSockets on Fluid Compute (billed by active CPU, not idle time; connections close at the 300 s Hobby limit). Because instances have no affinity, cross-instance delivery uses **Upstash Redis pub/sub** on channel `sig:{projectId}`.
- A device opens `/api/signal` **only when it needs peers** (not yet in a mesh), authenticating with its membership ticket; it closes once connected.
- One **gatekeeper** device per connected mesh (deterministically: longest-uptime eligible peer) keeps a signaling socket open (reconnect at ~290 s) so newcomers can reach the mesh; it then introduces newcomers to other peers *through the mesh* (peer exchange), so further SDP never touches Vercel.
- Every signaling payload (SDP/ICE) is encrypted end-to-end: X25519 ECDH between the two device keys (from their tickets) → HKDF → AES-GCM. The server only sees `(projectId, fromDevice, toDevice, ciphertext)`.
- Presence: Redis hash `presence:{projectId}` with 90 s TTL, refreshed by the gatekeeper.
*Alternatives*: HTTP polling mailboxes (invocation cost scales with idle time — exceeds free quotas); Ably/Pusher (another vendor holding metadata); public Nostr relays / MQTT brokers / BitTorrent trackers (free but unreliable and leak timing metadata to unknown operators); Cloudflare Durable Objects (technically ideal, but user requires Vercel). The signaling client sits behind an interface so a second transport can be added.

### D8. NAT traversal
STUN: public Google/Cloudflare STUN. TURN: **Cloudflare Realtime TURN** free tier, with short-lived credentials minted by `/api/turn` for authenticated members only (rate-limited). TURN sees only DTLS-encrypted traffic. Provider is env-configurable (e.g. metered.ca, self-hosted coturn).

### D9. Control plane stack and persistence
- **Hono** on Node.js Vercel Functions (Fluid), pinned to one region co-located with the database. Validation with Valibot (smaller than Zod).
- **Neon Postgres** (Vercel Marketplace, free) via `@neondatabase/serverless` HTTP driver + **Drizzle ORM**: durable data — users, sessions, email tokens, projects, memberships, bans, audit log, GitHub username links. Expected size is tiny (hundreds of bytes/user), far under free storage limits. Scale-to-zero adds ~0.5 s to the first request after idle — acceptable for login/ticket calls.
- **Upstash Redis** (Marketplace, free): rate limiting (`@upstash/ratelimit`, sliding window), signaling pub/sub, presence. Nothing durable lives there.

| Store | Verdict | Why |
|---|---|---|
| Neon Postgres | **chosen (durable)** | Real constraints (unique IDs/usernames), transactions, free, native Vercel integration |
| Upstash Redis | **chosen (ephemeral)** | TTLs, pub/sub, rate-limit library, free |
| Turso (libSQL) | viable alternative | generous free tier; less native Vercel integration |
| Supabase | rejected | free projects pause after inactivity |
| Airtable | rejected | ~5 req/s per base, record caps on free plan, no unique constraints/transactions → racy ID allocation, not a database |
| Dropbox API | rejected | file storage, no queries/atomicity; ToS not intended as app DB |

**Data model (Postgres):**
```
users(id, username_lc UNIQUE, username, email_lc UNIQUE, email_verified_at,
      pw_hash, pw_must_reset, is_admin, failed_logins, locked_until, created_at)
sessions(id, user_id, token_hash UNIQUE, kind[web|desktop], created_at, last_seen_at, revoked_at)
email_tokens(token_hash PK, user_id, purpose[verify|reset], expires_at, used_at)
projects(id, slug UNIQUE, pw_hash NULL, default_role, epoch, deleted_at, created_at)
memberships(project_id, user_id, role, joined_at, PK(project_id,user_id))
bans(project_id, user_id)
devices(id, user_id, ed25519_pub, x25519_pub, label, created_at, revoked_at)
github_links(user_id PK, github_login, github_id)   -- no tokens stored
audit_log(id, actor_id, action, target, at, meta jsonb)
```

**Free-tier budget (estimate, 100 active users × 60 h/month, 30 active projects):** ticket refreshes ≈ 30 k invocations, gatekeeper reconnects ≈ 22 k, joins/signaling/auth ≈ 10 k → ≈ 60–70 k of Vercel's 1 M monthly invocations; Redis ≈ 150–250 k commands/month; Postgres traffic is a few queries per call. Edits generate **zero** control-plane traffic. Vercel Hobby is for non-commercial use — documented in README.

### D10. Accounts and sessions
- Passwords: **argon2id** via `@node-rs/argon2` (OWASP params m=19 MiB, t=2, p=1); breached-password check with HIBP k-anonymity range API (5-char SHA-1 prefix only) and a bundled top-100k list as offline fallback.
- Sessions: opaque 256-bit random tokens, stored as SHA-256 hashes. Web: `__Host-p2p_session` cookie (Secure, HttpOnly, SameSite=Lax) + Origin check and a custom-header requirement on state-changing requests (CSRF). Desktop: bearer token stored in the OS keychain.
- Lockout and per-IP/per-account rate limits via Upstash ratelimit; generic error messages; constant-time comparisons; dummy argon2 verify for unknown users (timing parity).
- **Email** via a `Mailer` interface; default implementation is **Gmail SMTP** (nodemailer, dedicated Gmail account with 2-step verification + App Password, ~500 recipients/day). Reset/verify tokens are random, stored hashed, single-use, 30 min (reset) / 24 h (verify) expiry. The interface allows switching to Resend/SES without code changes elsewhere.
- **Platform admin**: `users.is_admin` set via a seed/CLI script (never via the API). Admin actions require a session re-authenticated in the last 10 min, and write to `audit_log`. Force reset sets `pw_must_reset`, revokes sessions, sends reset mail.

### D11. Membership tickets and peer authentication
- Each device generates an **Ed25519 signing key + X25519 key** (WebCrypto where available — non-extractable keys in IndexedDB; `@noble/curves` fallback; desktop private keys in OS keychain) and registers public keys with the control plane.
- Ticket = compact JWS (EdDSA, via `jose`) with claims `{v, pid, uid, uname, dev, devX, role, ep, iat, exp(≤15 min), kid}`. Control-plane signing key in Vercel env; public keys published at `/api/keys` and **pinned in the client build** (rotation via `kid`).
- **Connection binding**: after the DataChannel opens, each side sends `ticket + Sign_dev("p2platex/v1" ‖ pid ‖ localDTLSFingerprint ‖ remoteDTLSFingerprint ‖ nonce)`. Because the signature covers both DTLS fingerprints, a signaling server that swapped SDP to MITM would cause verification failure.
- **Fast revocation**: peers gossip the highest epoch they have seen in any valid ticket. A peer whose ticket epoch is lower must present a refreshed ticket within 60 s or is disconnected. Removed users can't refresh, so in practice revocation is ~1 min while any member is online and refreshing, with the 15 min expiry as hard bound.
- **Role filter** (`peer-sync` › *Read-only enforcement*): each connection is tagged with its verified role; from `viewer` connections only sync-step-1 (state-vector requests), awareness and compile requests are accepted; updates/blob announcements are dropped and never forwarded. The viewer UI also opens CodeMirror read-only.

### D12. Compilation engines and election
- **Desktop (native)**: embedded **Tectonic** (Rust crate; XeTeX-based, fetches packages on demand and caches them) plus detection of a system TeX distribution (TeX Live/MiKTeX/MacTeX via `latexmk`) which enables true pdfLaTeX/LuaLaTeX. Hardened: `-no-shell-escape`, `openout_any=p`, `openin_any=p`, working dir = materialized temp copy, wall-time limit (default 120 s), memory limit via job object (Windows) / rlimit (Unix).
- **Web (WASM)**: **SwiftLaTeX** pdfTeX/XeTeX engines in a dedicated Web Worker, lazy-loaded only when the device is leader or compiles locally. TeX packages are fetched on demand from a TeX file server (only package file names leave the device, never sources). *Alternative*: BusyTeX (includes LuaTeX, but much larger preloaded data).
- **Incremental builds**: the leader keeps a persistent per-project working directory; on each compile it writes only files whose content hash changed and keeps `.aux/.bbl/.toc` across runs, so typical recompiles run 1 pass + (bibtex/biber only if `.bib`/citations changed).
- **Capability score** (published on change, Lamport-stamped):
  `score = engineBase(native 100 | wasm 25) × perfFactor(benchmark of a bundled reference doc, measured at install/first run, re-measured weekly) × powerFactor(mains 1.0 | battery>50 % 0.5 | battery≤50 % 0.2) × (1 − cpuLoad) × engineSupport(project engine ? 1 : 0)`; opt-out ⇒ 0.
- **Election**: every peer computes `argmax(score, tiebreak deviceId)` over currently connected peers — no voting rounds needed. The current leader gets a +15 % hysteresis bonus to prevent flapping. Leader sends heartbeats every 2 s; a peer missing 3 heartbeats is excluded (failover < 10 s). Partitions naturally elect per-partition leaders and reconverge.
- **Pipeline**: leader debounces on document updates (1.2 s idle, 5 s max wait), snapshots files at a state vector, compiles, and distributes `{stateVectorHash, pdfHash, synctexHash, log, diagnostics}`; PDF and SyncTeX are blobs (D6), so peers already holding unchanged blobs fetch nothing and large meshes fetch from multiple peers. A compile in progress is never killed for a newer state; a single pending re-run is queued instead.
- Log parsing produces `{file, line, severity, message}` diagnostics shown inline.

### D13. Local folder mirror (desktop)
Rust `notify` watcher (debounced 100 ms) + `ignore` crate (gitignore semantics, built-in defaults + `.p2platexignore`). Disk→CRDT: read file, compute a minimal diff against the current `Y.Text` (Myers diff, `fast-diff`) and apply as a single transaction; binary files are hashed into the blob store. CRDT→disk: per-file debounced (200 ms) atomic write (temp + rename). Echo suppression: remember the hash of the last content written per path and ignore watcher events matching it. For viewers, disk changes are reverted and the user notified. This lets Claude Code / Codex / Cursor / any OpenRouter-based CLI operate on plain files with no plugin.

### D14. GitHub backup
- **GitHub App** (not OAuth App): user-to-server tokens limited to repositories the user selects, permissions `contents: write`, `metadata: read`; 8 h access tokens + refresh tokens. `/api/github/callback` exchanges the code with the client secret and hands tokens to the client (web: via a one-time code fetched by the SPA, never logged; desktop: loopback redirect). The server stores only `github_login`.
- Commits go **client → api.github.com directly** (CORS supported) with the Git Data API: compute git blob SHA-1 locally, upload only changed blobs, create tree with `base_tree`, create commit, update ref **without force**; on non-fast-forward, push to `p2platex/backup` and flag divergence.
- **Backup writer** = deterministic election (same mechanism as D12) among connected devices advertising a valid token for the bound repo, owners preferred. Policies evaluated by the writer: idle-T and every-N counters are tracked in the root doc's `meta` so they survive writer changes.
- Bootstrap/import: recursive tree + blob fetch, converted into a fresh root doc (or merged as edits if the project already exists locally).

### D15. Web security hardening
CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss://<host> https://api.github.com <tex-file-server> <stun/turn>; img-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'`. Plus HSTS, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, Trusted Types for DOM sinks. No third-party analytics. API errors never echo internal details. Dependabot/`pnpm audit` in CI.

### D16. License: AGPL-3.0-or-later
Overleaf and Oleafly are AGPL-3.0; adopting AGPL lets us adapt their code (LaTeX log parser, CM6 LaTeX language bits, Tauri/Tectonic integration patterns). Consequence: the public web deployment must link to its source. *Alternative*: permissive license with clean-room implementation — more work, no code reuse.

### D17. Efficiency summary
Zero control-plane traffic per edit; lazy subdocs; binary, compressed, backpressured wire protocol; content-addressed dedup for blobs/PDFs; incremental compiles with aux reuse; WASM engine and pdf.js loaded only on demand in workers; Svelte for minimal UI runtime; Tauri instead of Electron.

## Risks / Trade-offs

- [No peer online ⇒ project unreachable for new devices] → GitHub bootstrap; clear UI state; owners can leave a desktop running (it also becomes the compile leader).
- [Linux WebKitGTK lacks WebRTC on some distros] → Rust `webrtc-rs` transport behind the same interface (D3).
- [Symmetric NAT / corporate networks block UDP] → TURN over TCP/TLS 443 fallback; free TURN quota could be exhausted → configurable provider, per-user TURN rate limits.
- [Tectonic is XeTeX-based, not exact pdfLaTeX] → prefer a detected system TeX for pdfLaTeX projects; engine eligibility in election; document differences.
- [WASM TeX is slow and package fetching depends on an external TeX file server] → native peers always outrank WASM; cache packages in Cache Storage; server URL configurable (self-hostable mirror).
- [Malicious editor can corrupt content] → accepted trust model; local history + GitHub backups allow recovery.
- [Revoked member keeps local copy] → inherent to local-first; UI states this when removing members.
- [Vercel/Upstash/Neon free tier limits change] → budget estimate in D9, all providers behind small interfaces, metrics on invocation counts; Turso/other Redis as drop-in alternatives.
- [Gmail SMTP sending limits / account suspension for automated mail] → low volume (verify/reset only), `Mailer` interface to switch to Resend free tier.
- [Ticket signing key compromise] → key rotation via `kid`, keys only in Vercel env, short ticket lifetime.
- [Yjs tombstone growth on long-lived documents] → periodic compaction; GC enabled except where history snapshots require it.
- [CRDT LWW on concurrent rename of the same file to different names] → deterministic winner; loser's name visible in history.
- [Leader compiles a malicious document] → shell-escape off, path restrictions, time/memory limits, isolated temp dir.

## Migration Plan

Greenfield — no data migration. Rollout:
1. Create Vercel project; install Neon and Upstash via Marketplace (env vars auto-provisioned); add `TICKET_SIGNING_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GITHUB_APP_*`, `TURN_*` envs.
2. Run Drizzle migrations; seed the first platform admin via CLI script.
3. Deploy preview → run e2e (two browser contexts syncing + compile) → promote to production.
4. Publish desktop builds via GitHub Releases (Tauri updater with signed updates).
Rollback: Vercel instant rollback to previous deployment; schema migrations are additive-only during v1.

## Open Questions

- Which public TeX package file server to default to for the WASM engine (SwiftLaTeX's, or a self-hosted mirror on a free static host)? Configurable either way.
- Final production domain name and sender address for the Gmail recovery account.
- Exact capability-score constants — to be tuned with real benchmarks; formula shape is fixed.
