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
| Push service for rings (ntfy.sh or self-hosted) | deliver ring messages | read content, learn project or user identities, or authorize anything: it sees opaque topics, timing and IP addresses; rings are server-signed, short-lived and grant no access |
| Application relay role (optional, same control plane) | forward transient ciphertext between two sessions | read, store or replay project data (relay-specific E2E keys, authenticated frames, replay windows) |
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
| Revocation | epochs advance only from verified same-project tickets (an invented number is a rate-limited hint), per-device ticket freshness kept across reconnects, 60 s refresh grace, stale-epoch peers refused afterwards, removed users cannot get tickets | `packages/sync/test/epoch-authority.test.ts`, mesh tests, `e2e/full-flow.spec.ts` |
| Delayed work | document frames and privileged `APP` messages are authorized against the sender's current connection and role when applied, not when received | `packages/sync/test/epoch-authority.test.ts` |
| Content privacy | nothing but encrypted setup traffic reaches the server | `server/test/p2p-e2e.test.ts` › keeps document text … off the control plane |
| Signaling | in-band ticket auth (never in URLs), 64 KB messages, 60 msgs / 10 s, closed at ticket expiry | `server/test/signal.test.ts` |
| Doorbell | ring topics rotate with the membership epoch; ring tokens are EdDSA-signed, 60 s, carry no identifiers, verified offline with replay window and wake budget; ring endpoint member-only and rate-limited | `server/test/doorbell.test.ts`, `packages/sync/test/doorbell.test.ts`, `server/test/doorbell-e2e.test.ts` |
| Application relay | capability-negotiated, recipient-scoped routing, relay-specific handshake and keys, authenticated frames with replay windows, deployment budgets incl. socket time, no payload retention | `docs/application-relay-security.md`, `packages/sync/test/relay-*.test.ts`, `server/test/application-relay*.test.ts`, `server/test/relay-retention.test.ts` |
| Background seeds | owners/editors only; viewers refused at selection; demotion or revocation disables the seed at the next verified answer; dormant seeds hold no ticket or socket and verify rings offline against cached public keys; catalog stores no ticket or private key; locked keychain never yields a substitute identity; account switch stops every runtime before the next account activates | `packages/sync/test/seed-catalog.test.ts`, `worker-runtime.test.ts`, `runtime.test.ts` |
| Input validation | Valibot schemas on every body, 64 KB body limit, path-safety on project paths (no `..`, absolute, backslash, control chars; unsafe paths from peers are neutralised), zip-slip and zip-bomb checks | server tests, `packages/sync/test/model-sync.test.ts`, `apps/web/test/libs.test.ts` |
| Compilation | shell-escape disabled; writes outside the project refused (`openout_any=p`, MiKTeX `ALLOWUNSAFEOUTPUTFILES=f`); reads outside the project refused by MiKTeX (`ALLOWUNSAFEINPUTFILES=f`) and, for every distribution (TeX Live ignores `openin_any=p` for reads), detected after the run from the recorder (`.fls`) and bibliography log (`.blg`): if anything outside the project/TeX installation was read, the PDF, SyncTeX and log are withheld; `latexmk -norc` and project `latexmkrc`/`.latexmkrc` (Perl) never written; working-directory confinement, timeout, memory limit, process-tree kill | `cargo test` in `apps/desktop/src-tauri`: `write18` negative control, `project_latexmkrc_is_never_executed`, `files_outside_the_project_are_not_read` (absolute/`../` `input`, absolute image, absolute bibliography) on Windows/MiKTeX, macOS/TeX Live 2026 and Linux in CI |
| Folder mirror | commands only reach folders the user bound; traversal and symlink escapes refused | Rust `mirror` tests |
| Secrets | session token and device keys in the OS credential store; GitHub tokens never persisted server-side (sealed hand-off, one-time, 2 min) | desktop tests, `server/test/github.test.ts` |
| Web hardening | CSP (no inline script, no eval, `frame-ancestors 'none'`), HSTS, `nosniff`, no-referrer, Permissions-Policy; pdf.js without system fonts | `vercel.json`; Tauri CSP test |
| Dependencies | `pnpm audit` in CI (high+). Moderate advisories remaining are dev-only tooling (drizzle-kit's esbuild). | CI |

## Findings from the review (all fixed)

1. **Reconnection after removal** – a removed member could keep re-joining the mesh with a stale ticket. *Fix*: stale-epoch peers are
   refused once the 60 s grace has passed; the owner's client announces the new epoch immediately after each change. Epoch
   announcements are only trusted with a verified ticket attached: a member could otherwise announce an enormous epoch and make
   honest members look stale (audit F05).
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
* **Seeds are as available as the device and the push service.** A dormant seed is reachable only while the app runs and the push service (ntfy by default, configurable) delivers rings; when it cannot, the seed reports *ring channel unreachable* and deliberately does not keep a server socket open. Rings reveal to the push service only an opaque topic and timing, never project, user or device identifiers.
* **Seeding does not change who may read.** A seed replicates only what its own membership already allows; removed members keep their local copy as above.
* **A viewer cannot bootstrap a newcomer.** Viewers' state messages are dropped by design, so a new member needs an editor/owner online (or the GitHub backup).
* **Metadata** is visible to the control plane: accounts, which projects exist and who is a member, device public keys, when devices are online. Content is not.
* **Editors are trusted.** Updates are not individually signed, so a malicious editor can write anything an editor may write (and attribute it to the connection it came from).
* **Trusted Types** and per-update signatures were considered and not implemented.
* **A fixed TURN account is shared with every member.** With `TURN_USERNAME`/`TURN_CREDENTIAL` (e.g. ExpressTURN) the same relay credential is handed to every authenticated project member's device, so a member can read it and relay their own traffic at the account's cost. Relayed project traffic stays end-to-end encrypted. Use an account that can only relay, watch its quota, and rotate it when a member is removed or it leaks. Cloudflare's minted credentials expire after an hour.
* **Free-tier availability**: no SLA; if the control plane is down, existing meshes keep working until their tickets expire (15 min), but new joins, ticket refreshes and rings stop: dormant seeds stay asleep until the control plane returns.
* The in-browser TeX engine depends on a third-party TeX file server (configurable).

## Reporting

Please report vulnerabilities privately to the maintainers rather than in a public issue.
