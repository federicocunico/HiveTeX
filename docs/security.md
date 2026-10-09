# Security and privacy review

Scope: control plane (`server/`), peer protocol (`packages/sync`, `packages/crypto`), web and desktop clients, GitHub
backup. Method: design-level threat model, a pass over OWASP ASVS L2 areas (V2 authentication, V3 sessions, V4 access
control, V5 validation, V8 data protection, V9 communication, V13 API, V14 configuration), a dependency audit, and tests
for each control.

## Trust model

| Party | Trusted to… | Not trusted to… |
|---|---|---|
| Project **owners / editors** | edit content, relay data, compile for others | – (a malicious editor can damage content; history + GitHub backups allow recovery) |
| Project **viewers** | read | change anything (enforced by every honest peer) |
| **Control plane** (Vercel + Neon + Upstash) | authenticate users, issue short-lived membership tickets, relay *encrypted* connection setup | read or store document content (it never receives any) |
| Network / signaling relay | – | read or tamper with peer traffic (E2E-encrypted signaling; DTLS fingerprints bound into the peer handshake) |
| GitHub | store the optional backup | – |

## Controls and where they are tested

| Area | Control | Evidence |
|---|---|---|
| Passwords | argon2id, 12+ chars, breach check (HIBP range API, bundled fallback list) | `server/test/accounts.test.ts` |
| Brute force | per-IP limits, per-account 10-failure lock, identical errors, dummy hash for unknown users | same |
| Sessions | random 256-bit tokens stored as SHA-256, `__Host-` HttpOnly Secure SameSite=Lax cookie (web) / OS keychain (desktop), 30-day idle expiry, revocation | same; `apps/desktop/src-tauri` config tests |
| CSRF | custom request header + Origin allow-list on every state-changing request | `server/test/accounts.test.ts` › app skeleton |
| Recovery | single-use hashed tokens, 30 min expiry, neutral responses, mail sent after the response (no timing oracle) | accounts tests |
| Admin | out-of-band creation, password re-auth every 10 min, audit log | accounts tests |
| Access control | owner-only management, last-owner protection, bans, per-request membership checks | `server/test/projects.test.ts` |
| Join guessing | 80-bit random IDs, generic errors, 5 failures / 15 min per account and per IP, password hashed with argon2id | projects tests |
| Peer authentication | EdDSA tickets (pinned keys, `typ`/`alg` checked, ≤ 15 min), key-possession proof signed over **both DTLS fingerprints** | `packages/sync/test/handshake.test.ts`, `server/test/p2p-e2e.test.ts` (MITM) |
| Read-only | updates, blob announcements, compile results from viewers dropped and never forwarded | `packages/sync/test/mesh.test.ts`, `e2e/full-flow.spec.ts` |
| Revocation | epoch gossip, 60 s refresh grace, stale-epoch peers refused afterwards, removed users cannot get tickets | mesh tests, `e2e/full-flow.spec.ts` |
| Content privacy | nothing but encrypted setup traffic reaches the server | `server/test/p2p-e2e.test.ts` › keeps document text … off the control plane |
| Signaling | in-band ticket auth (never in URLs), 64 KB messages, 60 msgs / 10 s, closed at ticket expiry | `server/test/signal.test.ts` |
| Input validation | Valibot schemas on every body, 64 KB body limit, path-safety on project paths (no `..`, absolute, backslash, control chars; unsafe paths from peers are neutralised), zip-slip and zip-bomb checks | server tests, `packages/sync/test/model-sync.test.ts`, `apps/web/test/libs.test.ts` |
| Compilation | shell-escape disabled; writes outside the project refused (`openout_any=p`, MiKTeX `ALLOWUNSAFEOUTPUTFILES=f`); reads outside the project refused by MiKTeX (`ALLOWUNSAFEINPUTFILES=f`) and, for every distribution (TeX Live ignores `openin_any=p` for reads), detected after the run from the recorder (`.fls`) and bibliography log (`.blg`): if anything outside the project/TeX installation was read, the PDF, SyncTeX and log are withheld; `latexmk -norc` and project `latexmkrc`/`.latexmkrc` (Perl) never written; working-directory confinement, timeout, memory limit, process-tree kill | `cargo test` in `apps/desktop/src-tauri`: `write18` negative control, `project_latexmkrc_is_never_executed`, `files_outside_the_project_are_not_read` (absolute/`../` `input`, absolute image, absolute bibliography) on Windows/MiKTeX, macOS/TeX Live 2026 and Linux in CI |
| Folder mirror | commands only reach folders the user bound; traversal and symlink escapes refused | Rust `mirror` tests |
| Secrets | session token and device keys in the OS credential store; GitHub tokens never persisted server-side (sealed hand-off, one-time, 2 min) | desktop tests, `server/test/github.test.ts` |
| Web hardening | CSP (no inline script, no eval, `frame-ancestors 'none'`), HSTS, `nosniff`, no-referrer, Permissions-Policy; pdf.js without system fonts | `vercel.json`; Tauri CSP test |
| Dependencies | `pnpm audit` in CI (high+). Moderate advisories remaining are dev-only tooling (drizzle-kit's esbuild). | CI |

## Findings from the review (all fixed)

1. **Reconnection after removal** – a removed member could keep re-joining the mesh with a stale ticket. *Fix*: stale-epoch peers are
   refused once the 60 s grace has passed; the owner's client announces the new epoch immediately after each change.
2. **Timing oracle on password recovery** – sending mail only for registered addresses made response time reveal registration.
   *Fix*: the mail is sent after the response (`waitUntil` on Vercel).
3. **Path injection through the CRDT** – a malicious editor could write `../../x` into the shared file table, which would escape
   directories when peers export, mirror, compile or push. *Fix*: unsafe paths are neutralised in the model view and cannot be created locally.
4. **Read-only UI lag** – the editor stayed writable after a demotion. (Peers already dropped the edits.) *Fix*: reactive read-only state.
5. **Dead-peer lingering** – killed tabs stayed "connected" for ~30 s, delaying revocation and leader failover. *Fix*: liveness pings (20 s), and a reconnecting device replaces its old connection.
6. **Viewer relaying compile results / leadership** – viewers are now excluded from the election and their results are ignored.
7. **Server-side rate-limit lockout in tests** – not a product issue; the e2e server disables limits explicitly.

## Residual risks and limitations (documented, not fixed)

* **Compiling untrusted LaTeX on a collaborator's machine.** Shell escape is off, files outside the project cannot be read on any
  supported distribution (MiKTeX included, since it is now started with its unsafe-path switches off), and project build-tool
  configuration is ignored. TeX engines are still large programs processing untrusted input without an OS sandbox: only let
  people you trust compile on your machine.
* **Removed members keep their local copy**; they stop receiving updates within about a minute.
* **A viewer cannot bootstrap a newcomer.** Viewers' state messages are dropped by design, so a new member needs an editor/owner online (or the GitHub backup).
* **Metadata** is visible to the control plane: accounts, which projects exist and who is a member, device public keys, when devices are online. Content is not.
* **Editors are trusted.** Updates are not individually signed, so a malicious editor can write anything an editor may write (and attribute it to the connection it came from).
* **Trusted Types** and per-update signatures were considered and not implemented.
* **Free-tier availability**: no SLA; if the control plane is down, existing meshes keep working, but new joins and ticket refreshes stop (tickets last 15 min).
* The in-browser TeX engine depends on a third-party TeX file server (configurable).

## Reporting

Please report vulnerabilities privately to the maintainers rather than in a public issue.
