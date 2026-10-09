# Proposal

## Why

Overleaf-style collaborative LaTeX editing today requires trusting (and often paying) a central cloud that stores unpublished research and burns server CPU on every compile. p2platex delivers the same real-time, offline-capable co-authoring experience for free by keeping sources only on the co-authors' devices, syncing them peer-to-peer, and letting the strongest connected machine compile the PDF for everyone. A tiny, free-tier Vercel "control plane" handles only accounts, project lookup, permissions and connection bootstrap — never document content.

## What Changes

- New greenfield monorepo with one shared TypeScript client that runs both as a **web app on Vercel** and as a **Tauri desktop app** (Windows/macOS/Linux).
- **Accounts**: username + password (argon2id), email-based recovery sent through Gmail, and a platform-admin "force password reset" action.
- **Project registry**: each project gets a unique, owner-customizable ID; joining requires ID + project password (password protection on by default); joiners enter instantly with the owner-configured default role (read-only by default); the owner can change any member's role (owner / editor / read-only) or remove them, with no member limit.
- **P2P sync**: WebRTC data-channel mesh between members' devices, bootstrapped by the Vercel control plane with server-signed membership tickets; documents are CRDTs (Yjs) persisted locally so editing works fully offline and merges automatically on reconnect without duplicates or overwrites. Text, images and bibliography all sync; binaries use content-addressed chunked transfer.
- **Distributed compilation**: peers advertise compile capability (native TeX vs WASM, CPU benchmark, power state, load); a deterministic election picks the best online peer as compile leader, which compiles and streams the PDF (+ SyncTeX) to everyone; automatic failover to the next-best peer when the leader leaves.
- **Read-only enforcement** at the P2P layer: updates from read-only members are rejected by every honest peer; revocations take effect within the ticket lifetime.
- **Local workspace mirror** (desktop): the project is mirrored to a plain folder on disk and file changes are folded back into the CRDT, so Claude Code, Codex, Cursor, OpenRouter-based tools, etc. can work on it locally.
- **GitHub backup**: GitHub App OAuth to link a project to a repository; automatic commits every N changes or after T minutes of inactivity, pushed directly from a member's device; GitHub can also be used to bootstrap a project when no peer is online.
- **Security & privacy hardening** throughout: document content never transits or rests on the control plane; E2E-encrypted signaling; rate limiting; strict CSP; locked-down Tauri capabilities.

## Capabilities

### New Capabilities
- `user-accounts`: registration, login, sessions, email recovery, admin force-reset, platform admin role.
- `project-access`: project IDs, project passwords, membership, roles, default role, permission management, revocation, membership tickets.
- `peer-sync`: signaling/bootstrap, WebRTC mesh, peer authentication, CRDT document model, offline persistence, binary asset transfer, role enforcement on incoming updates.
- `distributed-compilation`: capability advertisement, compile-leader election and failover, compilation engines (native/WASM), PDF/SyncTeX distribution, local compile override.
- `latex-workspace`: the editor client (file tree, LaTeX editor, PDF preview, presence), web vs desktop packaging, and the local folder mirror for external AI/coding tools.
- `github-backup`: GitHub linking, backup policies (every N changes / idle T), direct client-to-GitHub commits, bootstrap-from-GitHub.

### Modified Capabilities
- None (no existing specs).

## Impact

- **New code**: `apps/web` (Vite SPA), `apps/desktop` (Tauri 2 shell + Rust compile/mirror services), `apps/api` (Vercel Functions), `packages/*` (shared protocol, sync engine, crypto, UI).
- **External services (all free tiers)**: Vercel Hobby (static hosting + Functions), Neon Postgres (durable accounts/projects), Upstash Redis (ephemeral signaling mailboxes, rate limits), Gmail SMTP (recovery mail), Cloudflare Realtime TURN free tier (NAT fallback relay, configurable), GitHub App.
- **Rejected stores**: Airtable (5 req/s, record caps, not a database) and Dropbox API (file store, no queries/transactions) — see design.md.
- **Licensing**: Overleaf and Oleafly are AGPL-3.0; reusing their code makes p2platex AGPL-3.0. Decision recorded in design.md.
- **Known limitation**: a project is only reachable when at least one member device is online (or via GitHub backup, for members with repo access).
