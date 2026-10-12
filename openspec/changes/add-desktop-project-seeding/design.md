# Design

## Context

See proposal.md for motivation and scope. This is a planning-only change based on commit
`b4e164796819ed70d79790444bb7f7127472294a` (desktop 0.5.0), in the dedicated worktree
`C:/Users/feder/.codex/worktrees/3473/p2platex`. The earlier harden-realtime-peer-sync change is already archived and its fixes are baseline requirements, not outstanding defects.

### Focused architecture audit

The following findings were established by source inspection. Priority indicates implementation sequencing, not a claim of an exploited vulnerability. No new runtime reproduction or performance measurement was performed for this proposal.

| Priority | Observed evidence | Consequence for persistent seeding | Resolution |
| --- | --- | --- | --- |
| P1 | `apps/web/src/views/Workspace.svelte:183-222` constructs a session in asynchronous mount, assigns it after open, and closes it on unmount | Navigation destroys the active mesh; unmount before assignment also permits a late orphan session unless cancellation is added | D1, D3: application lifetime and generation-scoped attachment |
| P1 | `apps/web/src/lib/session.svelte.ts:183-325,1233-1261` owns model, store, mesh, ticket loop, mirror, compiler and backup together | Running one full session per seed starts unrelated expensive or externally writing services | D2: split sync core from foreground services |
| P1 | The desktop also opens `IndexedDbPersistence`; persistence includes atomic document/metadata transitions | A native background process cannot reuse a renderer-owned database by simply keeping Rust alive | D4: native transactional store and staged migration |
| P1 | `session.svelte.ts:startManager` normally chooses browser RTC; `rtc.rs:create` uses default ICE socket allocation | A random UPnP port is unrelated to the sockets carrying most desktop traffic today | D6-D7: native desktop RTC and socket-backed mapping |
| P1 | `RtcState` emits into webview events; tickets and retries use the session's JavaScript lifecycle | Keeping a tray icon alone does not keep document processing, renewal and persistence independent of the renderer | D1: supervised headless runtime and native transport routing |
| P1 | `local-projects.ts` and desktop IndexedDB keys use project IDs without a server/account namespace | A new background catalog must not infer authorization from a same-ID cache | D4-D5: explicit identity scope and migration association |
| P2 | `lib.rs:run`, Cargo.toml and tauri.conf.json contain no tray, autostart or single-instance lifecycle | Closing the window has no defined persistent-seed behavior or recovery controls | D1, D9 |
| P2 | `docs/security.md` disallows viewer bootstrap, while the main peer-sync spec says “any online peer” | Advertising viewer caches as seeds would promise unsupported availability or weaken role enforcement | peer-sync delta clarifies eligible owner/editor sources |
| P2 | `auth.svelte.ts` changes frontend auth state on logout/local-mode transitions | An independent service needs an awaited account barrier, not just a route change | D5 |
| P2 | Existing connection and sync-status suites cover recovery, but no no-renderer multi-project seed test exists | Foreground success is insufficient evidence of background reliability | D10 |
| P1 | `server/src/signal/hub.ts` broadcasts signaling through project-wide Pub/Sub; server and local adapters cap frames at 64 KiB and the hub limits 60 messages/10 s | Reusing signaling unchanged cannot provide bounded, reliable application delivery or efficient recipient-only traffic | D11 |
| P1 | `packages/sync/src/transport.ts` and `connection.ts` bind possession proofs to DTLS fingerprints; crypto seal/open use the signaling envelope domain | Raw WebSocket frames need their own authenticated channel binding, keys and replay rules | D12 |
| P1 | `server/src/production.ts` uses Vercel WebSockets; `vercel.json` sets 300 seconds; Pub/Sub does not retain missed traffic | Application relay must recover from socket/instance replacement without treating publish as delivery | D11-D12 |
| P2 | `ConnectionManager` heartbeats every 30 s and hub renewals use Redis; deployment docs budget only signaling for edits | Always-on seeds and relayed edits materially change free-tier usage | D13 |
| P1 | Vercel bills Provisioned Memory for an instance's whole lifetime while any request is in flight, idle WebSockets included (Fluid compute pricing docs, checked 2026-10-12; Hobby: 360 GB-h, 4 h Active CPU, 1 M invocations). Measured in verification.md: four idle seeded projects of one device ≈ 0.5-0.8 M Redis commands per 30 days, mostly 300 s socket rotations | Any connection held open while idle, including today's gatekeeper socket, exhausts the free tier; at 2 GB one always-open socket somewhere costs ≈ 1,440 GB-h per month | D14: no idle connections; doorbell wake-up |

Existing contracts preserved: Yjs updates and verified blob transfer; manual/offline three-way merge; current-session reconciliation; <=15-minute membership tickets and epoch checks; bounded fragment and transport queues; local-mode network silence. `background-processes` already requires hidden child processes and `proc::background_command` enforces it.

## Goals / Non-Goals

**Goals:** zero control-plane cost for idle devices and free-tier-only hosting that scales with the number of introductions rather than the number of installed seeds; an authenticated server fallback for web and desktop without a new relay provider; one authoritative synchronization owner per server/account/project; renderer-independent lifetime; bounded, observable resource and deployment usage; genuine mapped ICE connectivity; cross-platform packaging and recoverable migration.

**Non-Goals:** paid hosting plans or paid push services; sub-second wake-up of a dormant seed; a system service running before OS login or after explicit quit; preventing sleep; anonymous/public torrents; a DHT or central content store; viewer-authored replication; automatic conflict decisions; background builds, GitHub pushes or filesystem imports; PCP/NAT-PMP or IPv6 pinhole management. Normal IPv6 ICE remains available.

## Decisions

### D1. Native supervisor with a bundled headless JavaScript runtime

The Tauri Rust process owns tray/lifecycle, single-instance lock, credentials, disk persistence, native RTC and router mappings. It launches one packaged JavaScript worker using a pinned bundled Node runtime compatible with the repository's Node >=22 constraint. The worker reuses the existing TypeScript/Yjs sync packages; the user does not install Node.

Use a fixed bundled executable/resource path and typed, versioned, length-bounded messages over inherited pipes. No localhost HTTP control server, arbitrary command dispatch, shell plugin or generic filesystem permission. Start via `proc::background_command` with piped input overriding its default null stdin; clear runtime-injection environment variables such as NODE_OPTIONS/NODE_PATH. Maintain request IDs, cancellation generations, byte budgets and backpressure in both directions. Reject unknown protocol versions and methods.

Route RTC callbacks directly to the owning worker generation instead of broadcasting document traffic to a window. On worker failure, fail pending calls, close its RTC peers, retain durable data and restart with exponential jittered backoff (1-30 seconds, at most five crashes per ten minutes before “needs attention”). On parent exit, pipe EOF and native process lifetime management terminate the child; on Windows, use a kill-on-close job object. No orphan worker can keep announcing a device after the supervisor has quit.

The renderer can be hidden, destroyed or recreated without owning network timers. A renderer reload reattaches to existing sessions. Native sleep/resume and interface-change signals wake recovery independently of the renderer.

The supervisor/worker also owns the doorbell subscription (D14). A dormant project has no network actor at all: no signaling socket, no RTC peer, no ticket timer and no UPnP mapping. It wakes on a verified ring, an editor attachment or a resume/recovery event that has work to do, and returns to dormant after its last peer and editor are gone.

Alternatives: retaining a hidden webview is smaller but still couples persistence and ticket processing to renderer throttling/crashes. Tauri's background-throttling control is not supported on Windows/Linux according to its API documentation, so it is not the reliability foundation. Porting the whole Yjs/offline-merge engine to Rust would create protocol parity risk. A system daemon adds credentials and install complexity outside the requested logged-in tray behavior.

### D2. Extract a sync-only project actor and registry

Create a framework-neutral runtime package around ProjectModel, Mesh, BlobManager, OfflineFork, SyncTracker, ChangeLog and ConnectionManager. Move ticket recovery, trusted-key cache and synchronization policy out of Svelte state; inject clock, storage, identity/API, transport and status sinks. No DOM, localStorage, toast, Tauri imports or compiler setup in the shared core.

A registry serializes start/stop/attach/detach per canonical `(serverOrigin, userId, projectId)`. Concurrent starts share one promise; stop invalidates pending initialization before disposing it. Child peers use namespaced connection IDs so several projects cannot collide in Rust's peer map. UI acquisition uses a cancellable attachment lease; releasing a late lease cannot stop a newer attachment.

A session runs when it has an editor attachment or eligible enabled background demand, unless account policy or explicit pause forbids networking. Background demand means a verified ring, a connected peer, or pending hydration work towards connected peers; an enabled seed without demand stays dormant (subscribed, not networking). Disabling only background seeding does not disconnect an open editor. Closing the last editor stops compiler/election/backup/mirror scheduling, clears editor awareness, and leaves only the sync actor when eligible. Foreground services retain their existing behavior while attached; in-flight backup/build work settles or cancels using existing authorization and cancellation checks. Do not create a separate Mesh for foreground services.

The web app uses the same core through browser adapters with current workspace-scoped lifetime. Desktop UI and service communicate through a local adapter. Preserve old browser protocol compatibility; optional awareness fields need no protocol version bump.

Alternative: a global collection of existing ProjectSession instances is less work initially but starts compilers, auto-backup, toasts and folder imports for every retained project and retains renderer lifetime dependence.

### D3. Editor bridge and lossless handoff

Keep CodeMirror/Yjs editing responsive with a transient renderer replica; it is not another network peer or persistence owner. On attachment, receive the root/file state vectors and actor revision, reconcile using Yjs updates, then subscribe to ordered deltas. Buffer updates during snapshot attachment and remove the buffer only after the revision barrier. Use origin tags to prevent echo and preserve change-log attribution.

For local edits, send bounded mutation batches with an attachment ID and sequence number. The actor checks current role and offline-fork policy, applies the update once, persists it, and acknowledges local durability separately from peer reconciliation. Until durable acknowledgement, show pending/save error and retain the update in a Rust-owned ingress journal keyed by account/project/attachment/sequence. Native IPC acceptance must journal before acknowledging custody; renderer-only receipt is never “saved.” After worker failure replay journaled edits idempotently through the same authorization/recovery path. A role change retains denied pending data for export and must not publish it.

Conflict resolution, file operations, restore/undo and imports go through typed actor commands, not replacement of whole text snapshots. Preserve CodeMirror undo semantics and original edit origins. The worker owns offline-merge checkpoints; the renderer displays conflict inputs and submits a revision-checked resolution. Late renderer callbacks cannot publish stale resolutions.

Foreground compiler, backup and mirror adapters access the authoritative project through that same bridge and its mutation/availability APIs; they never instantiate a second durable store/mesh. Explicitly audit `local-projects.ts` copy/publish/link/delete and folder/export flows to remove direct desktop IndexedDB assumptions.

Alternatives: rebuilding documents on every open risks undo/history and offline-fork state. Treating the UI as a second peer creates duplicate device authentication, synchronization and storage ownership.

### D4. Native transactional persistence and migration

Implement the existing Persistence interface through a narrow Rust SQLite adapter (bundled SQLite via a pinned crate). Store document updates/compaction, metadata, blobs, history and change sets under scoped project IDs. SQLite transactions must preserve `transact(StoreOp[])` atomicity; use WAL and durable commit settings. Bound IPC payload sizes and stream large blobs in chunks to staged storage; publish a blob only after hash verification and commit. Maintain a disk reserve for journal/recovery writes instead of consuming the entire quota on assets.

One writer owns each scoped project. The renderer never writes the authoritative database. Local-only desktop projects can use the same storage adapter with a separate local namespace and no network actor.

Migrate under a project lock with the old writer stopped: enumerate all IndexedDB stores, including metadata/recovery keys, and copy in bounded batches. Persist source schema, target schema, account/server association, progress, record counts and content checksums. Import raw Yjs identities/updates and completeness markers without creating new authored state. Verify a reopened target and recovery fixtures before atomically switching the active-store manifest. Keep the source read-only; interrupted migration retries idempotently.

Legacy cache keys lack scope. Only migrate into a background-shareable namespace when the current server/account association is established; otherwise show “migration needs account confirmation” and allow local export. A cached project ID is not proof. During the first upgraded launch the migration webview may run to access IndexedDB; projects waiting for that step must not advertise seeding. Subsequent background launches need no renderer.

Alternatives: a webview persistence proxy retains the renderer dependency. Concurrent old/new writes with eventual copying can lose merge journals or create split ownership.

### D5. Catalog, authorization and availability policy

Persist a local catalog of retained shared projects and their seeding preference scoped to account/server. Automatically enable eligible owner/editor retained projects as dormant seeds reachable on ring (D14), visibly explain this behavior in desktop settings, and allow per-project disable. A dormant seed fetches a fresh ticket only when woken; it never renews tickets while idle. A newly joined but never-downloaded project requires Download and seed or first foreground open. Background downloads do not update “last opened” recents.

Only the active signed-in account/server runs sessions. Native keychain storage remains the source for private keys and desktop bearer credentials; do not write secrets into the catalog, SQLite metadata, command arguments or logs. If credentials are locked/missing, report authentication required; no memory-only replacement identity for seeding. Reuse established device identity and control-plane trust validation.

Logout, local mode and account/server switches establish a local stop barrier before continuing potentially slow remote requests: increment account generation, reject new work, stop signaling/data channels and ticket timers, cancel privileged callbacks, flush data, release credentials from worker memory, and remove unused mappings. Old account data stays on disk but cannot be attached from the new account. Authoritative removal/deletion stops affected sessions; demotion stops seed eligibility and enforces existing viewer behavior for an attached reader. Use current ticket/epoch rules with no special seed exemptions.

The current control plane is still required for discovery and ticket renewal. A complete cached replica is not evidence of current global state. During an outage, currently valid peer authorization remains valid only for its existing lifetime; after expiry networking stops until reauthorized.

### D6. Native transport for desktop

Use the Rust WebRTC adapter for desktop WebRTC paths; browsers retain browser RTC. Both also use the shared application-relay adapter described in D11-D12. Move the existing RtcPeerLike wrapper's invocation/event transport behind an injectable bridge so worker callbacks do not require the Tauri JavaScript API.

A process-level transport service binds UDP sockets on the selected routable interface and multiplexes peer connections using `webrtc-ice 0.13.0 UDPNetwork::Muxed`. Scope per-network generations and reference-count listeners across projects. Preserve ICE consent, DTLS, project key proofs and encrypted signaling. A UDP port never serves a project before authentication.

Native adapter parity must include channel ordering, send/backpressure termination, candidate trickle, selected-candidate statistics, credential refresh, close races and browser interoperability. Preserve ordinary host, STUN, IPv6 where available, and TURN candidates. A mapping or native enhancement failing must not prevent ordinary native ICE from starting.

### D7. UPnP manager connected to actual ICE sockets

Implement a Rust IGD adapter with bounded discovery, request deadlines, response/XML limits and a mockable gateway interface. A reviewed pinned UPnP client is an implementation dependency; the contract is library-independent. Discover only on the chosen default-route interface; validate response sender, gateway identity and service URLs within that local gateway scope. Reject arbitrary off-network URLs, redirects and unbounded bodies. Never accept router URLs from remote peers.

Allocate an application-owned UDP listener first. Request a same-port UDP mapping with a 30-minute lease, verify its tuple and gateway-reported public IPv4, and renew halfway through the granted finite lease with jitter. If the requested port conflicts, try at most three newly bound candidate ports. Never remove/replace another mapping; ownership records contain a random installation mapping token and verified internal endpoint. Query the tuple before renewal/removal, and refuse operations on ambiguous ownership. A gateway that only accepts permanent leases is unsupported for automatic mapping. This sacrifices some old routers in favor of bounded crash cleanup.

Share mappings across projects, not one mapping per file or peer. UPnP defaults on for authorized active desktop sync, with an independent toggle. No discovery in local mode, signed-out state or global pause. On account/network generation change, late successful mappings are compensating-cleaned and never published. Last eligible session stop, disable or orderly quit removes owned mappings best-effort within a three-second cleanup deadline. Abrupt failure relies on finite expiry. Retry discovery after route change or bounded backoff, not per keystroke or per failed peer.

**Installed-library constraint:** the inspected `webrtc 0.13.0` setting engine supports muxed UDP and `set_nat_1to1_ips`, but Host replacement drops private host addresses; Srflx mapping disallows simultaneous STUN configuration and gathers through a separate socket path. The mux gatherer uses its actual local port. Therefore neither simple IP rewriting nor editing outgoing SDP is a correct additive UPnP implementation.

Add a narrowly scoped, pinned ICE extension for verified external endpoints on a mux socket, preserving ordinary host/STUN/TURN candidates. Register a mapped server-reflexive candidate backed by the same mux connection/ufrag and exact external address/port, with the real local endpoint as its related address. Expose only the verified mapping generation from the Rust transport service. Implement as a small version-pinned source patch to the existing webrtc/ICE dependency boundary, with an upstreamable regression test; do not opportunistically upgrade the transport stack. Initially accept only same-port mappings. A router returning a different port is cleaned up and ordinary ICE is used.

An expired/changed mapping is excluded from new negotiations immediately; obsolete ICE candidates are retired by a controlled connection generation replacement when necessary. Preserve a working selected pair until replacement succeeds where authorization permits. Mapping success is distinct from ICE pair selection. STUN/TURN negotiations do not wait indefinitely for UPnP; cap the initial mapping attempt at three seconds and continue ordinary ICE concurrently. A late mapping becomes available for subsequent controlled attempts without disrupting healthy links.

Alternatives: mapping arbitrary ports does not reach the actual RTC sockets. A separate raw TCP sync protocol would duplicate security/protocol logic and break browser interoperability. Permanent leases, DMZ and automatic firewall changes are excluded.

### D8. Full replicas, scheduling and operational bounds

Reuse SyncTracker's current-reconciliation and availability rules. A background hydration queue requests all known text documents and referenced binary hashes; identity changes cancel obsolete fetches. Verify hashes, limits and current sender authorization before persistence. Report bytes/files remaining and independent durability/reconciliation states. “Seed complete” means complete for the last verified known root, not omniscient freshness.

Initial adjustable local-device defaults: four concurrently awake background projects (dormant seeds are unlimited and free), two concurrent background blob fetches globally, one per project, a 5 MiB/s bulk-transfer cap in each direction, and a 2 GiB retained background-download budget. These are not server-relay allowances: the lower D13 deployment grants and relay queue limits always take precedence. Existing retained content over that budget is kept; reserve an additional 128 MiB for journal/recovery writes where disk capacity allows, and report insufficient space when it does not. Foreground projects do not consume background slots but remain subject to per-peer protocol limits. Prioritize control messages and foreground text over bulk traffic using fair queues.

When projects exceed the active limit, rotate background slots fairly, at most once per minute unless demand/availability changes. Queued projects are explicitly unavailable as seeds until activated. An active transfer gets at most a five-minute scheduling extension before checkpoint/requeue so a large project cannot starve the rest. User limits can be increased to keep all selected projects simultaneously available; defaults trade availability for bounded resources.

Keep a receive-buffer budget (initially 32 MiB across background blob transfers) in addition to existing per-peer bounds. Do not evict seed-required content, unsaved edits or recovery journals to satisfy a quota. A project too large for the budget remains partial until the user changes selection/limits. No automated disk imports while only seeding: external folder changes reconcile using existing guards on next editor attachment.

### D9. Tray and observable state

Use native tray, single-instance and launch-at-login integration for Windows/macOS/Linux; keep plugin permissions narrow and select versions compatible with the repository's Rust toolchain. Launch-at-login is offered, not silently enabled; start-in-background applies once selected. Close hides/destroys the editor without exiting the supervisor; explicit Quit establishes the stop barrier and checks durable flush before termination.

If no tray can be created, retain/show a usable window rather than hiding irretrievably. Second launch reveals the existing UI, including on Linux without tray support. OS shutdown is bounded and uses already durable journals; do not block logout indefinitely. User-requested quit on unsaved data exposes recovery/export instead of silently discarding.

The local dashboard lists per-project stage (dormant and reachable on ring, waking, active, ring channel unreachable), partial contents, last successful reconciliation, authorization and storage failures, limits and pause controls. Each peer shows its selected direct WebRTC, TURN or application-relay route and any relay-limited state. UPnP has independent disabled/discovering/mapped/renewing/unsupported/failed status; a mapping is never a “connected” badge. Keep local endpoint diagnostics on device; redact tokens, keys and project content from logs. Background notifications are coalesced and do not steal focus.

Helper pairing explicitly requested from a browser must show the main window before focusing it; today's unminimize/focus alone is insufficient after hide-on-close. Updater restart follows the same flush/stop barrier, does not spawn a duplicate seed, and restores preferences after restart.

### D10. Acceptance and evidence

Feature acceptance requires actual packaged-app evidence, not a mock tray or a port-mapping SOAP response alone:

- Before desktop migration, test browser/browser and desktop/browser application relay with direct WebRTC and TURN unavailable. Inject Pub/Sub loss/reordering, sender impersonation, replay, wrong-project routing, ticket expiry, a 300-second socket rotation, cross-instance reconnect and a budget reset. Prove server payloads are transient ciphertext and that publish success cannot falsely complete sync.
- Measure idle and active command/byte/function usage, including ACK/retry traffic and multiple always-on projects; force budget/accounting failures and prove unrelated direct links stay usable. Include a missing image with all text received and verify no complete-project status is emitted.
- Test relay-to-direct handover during concurrent edits and a blob transfer; require current-generation ownership, preserved work and continued viewer/revocation enforcement. Repeat the existing healthy-network latency target on the application relay with adequate configured budget, and report quota-limited runs separately.
- Two retained projects sync while the desktop has no editor renderer; a fresh browser member bootstraps text and an image from the seed after the original author disconnects.
- Seven typing peers plus background hydration retain the existing p95 <=250 ms healthy-network propagation target; run the 12-peer convergence/duplicate-relay checks as applicable.
- Run hidden/no-renderer for at least 60 minutes, alternating dormant periods and wake cycles: while dormant the seed makes zero control-plane requests and holds no socket, mapping or RTC peer; each wake covers ticket fetch, relay refresh with shortened fixture expiry and mapping renewals. Measure CPU, RSS, file descriptors, queue bytes and logs; resource growth must remain bounded rather than increasing per wake or reconnect.
- Doorbell: a newcomer reaches a dormant seed with p95 ring-to-authenticated-link time <= 10 s on a healthy network; forged, expired, replayed and old-epoch ring tokens wake nothing; a removed member cannot ring the project; with the push channel unreachable, editing and already established links continue and the status says the project is reachable only while open; a three-device mesh answers a ring with one representative socket.
- Inject storage-full, worker/renderer crash, restart during offline merge and migration checkpoints. Restart recovers durable data without reapplying a merge or inventing completeness.
- Emulated IGD/NAT tests prove mapped socket traffic via selected candidate and packet observations with TURN disabled; separate tests verify TURN fallback and interoperability when UPnP fails. Cover port collision, unsupported/permanent-only routers, CGNAT/double NAT, no hairpin, gateway reset, malformed responses and disable-during-add.
- Repeat tray/startup/quit/single-instance/resume tests on packaged Windows, macOS and Linux. Current desktop WebDriver coverage includes Windows/Linux; document a reproducible macOS native/manual check where equivalent automation is unavailable.
- Reuse existing `packages/sync/test`, `e2e/realtime.spec.ts`, `e2e/relay-only.spec.ts`, `e2e/offline-merge.spec.ts` and desktop e2e harness. Extend targeted suites per implementation step rather than postponing coverage to the end.

### D11. Application relay on the existing server, implemented first

Implement this path in the current browser/desktop connection manager before the background-runtime migration. It subsequently moves unchanged behind the shared core adapter. UPnP, the native ICE patch and a configured TURN provider are not dependencies of the application relay.

Extend the existing authenticated /api/signal WebSocket with an explicitly negotiated application-relay capability and a distinct message family. Retain the current signaling handshake and per-project ticket proof. Do not disguise application data as an SDP signaling envelope or remove the existing signaling rate limit. The server's ready response and peer introduction advertise optional relay support; require a server acknowledgement and a fresh peer handshake before use. An older server or client continues using the unchanged WebRTC protocol.

Route application ciphertext to a recipient-specific, environment/project/device/session-scoped Upstash Pub/Sub channel, subscribed before advertising readiness. Existing project-wide join/leave discovery remains separate. Never publish bulk application traffic to the whole project channel and filter only after fan-out. The sender's identity/project come from its authenticated socket; verify that the target is a live authorized same-project session and bind delivery to its current session ID. No arbitrary channel names from clients. Target/session replacement invalidates outstanding routing grants. Peers still enforce ticket/epoch freshness and content roles on receipt.

The server handles transient ciphertext as a logically separate relay role on the same infrastructure. The control-plane privacy contract still forbids readable content and content storage: no Redis streams/lists, durable retry queue, database payloads, payload logging, request-body capture or error telemetry containing envelopes. Only bounded transit buffers, expiring routing/usage metadata and existing presence remain. All durable work stays on member devices. A complete project still requires an available owner/editor source; the relay does not provide offline cloud bootstrap.

The current WebSocket maximum is 64 KiB, including JSON/base64 overhead, and the signaling hub accepts 60 messages per 10 seconds. Keep that outer byte ceiling; fragment application records into at most 16 KiB plaintext pieces before authenticated encryption and encoding. Define separate reserved control/signaling and relay admission budgets plus a bounded total socket queue. Batching small updates must never delay foreground text more than 25 ms solely to save publishes. Use recipient-side ordering, authenticated acknowledgements and bounded retransmission because Pub/Sub delivery is at-most-once; a successful publish is not recipient receipt. See [Redis delivery semantics](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics).

Start with a 256 KiB unacknowledged relay window per peer and 4 MiB total per-device relay send/reorder budget, subject to lower server grants. Keep the existing decoded-message/fragment lifetime caps and account for partial reassembly against an explicit aggregate receive budget. Authenticate each fragment before retaining it; bound message count, declared size, decompression and assembly lifetime. A fragment receipt ACK releases transport credit, not the project's durable or reconciliation status. Retransmit identical ciphertext only within the same live key generation; bound retries and fail the generation on persistent gaps. On reconnect establish new keys and reconcile Yjs state and missing blobs from endpoint storage instead of replaying old encrypted sessions. Never reuse a nonce for different plaintext.

### D12. Relay-specific cryptographic binding and route handover

The existing seal/open primitives provide X25519, HKDF and AES-GCM building blocks, not a complete reusable data transport. Their signaling domain and long-lived device exchange key must not become a shared signaling/data session key. Existing PeerTransport and PeerConnection bind authentication to DTLS fingerprints; a relay implementation must not fake those fingerprints or skip possession proofs.

Define a versioned relay handshake using fresh ephemeral X25519 keys and fresh challenges, authenticated by the existing device Ed25519 keys verified from current tickets. Canonically encode a domain-separated transcript covering version, project, both ordered device identities and ticket-bound public keys, both ephemeral keys, both challenges, roles in the handshake and a fresh connection generation. Reject invalid keys and all-zero shared secrets. Derive separate directional encryption and confirmation material using HKDF with the complete transcript binding. Use unique per-direction AES-GCM nonces from a session-specific prefix and monotonic counter, with rekey before exhaustion. Bind project, peers, generation, channel, message/fragment identity and counter as authenticated context; use bounded replay windows. Confirm possession of derived keys in both directions before sending project frames. Erase ephemeral secrets when no longer needed.

Generalize the transport binding explicitly: preserve the exact legacy DTLS transcript for WebRTC, and use a distinct tagged relay binding for negotiated relay peers. Reuse existing post-authentication role filters, ticket refresh, epoch checks and bounded decoding. A role downgrade or expiry invalidates delayed privileged work even if it was queued while authorized. Crypto transcript construction and lifecycle need negative tests and focused review before production enablement.

Runtime preference is a healthy direct path (including successful UPnP), configured TURN if it is already usable, then the application relay when neither is usable. TURN (for example the Cloudflare Realtime free tier) costs the control plane nothing per byte, whereas every application-relay session holds signaling sockets open; when TURN credentials are configured, relay setup waits for that WebRTC attempt to fail or time out. Implementation order is different: deliver the application fallback before investing in UPnP optimization. Start relay setup within 10 seconds of learning that both online peers and the server support it if no usable WebRTC path exists. Do not wait indefinitely for TURN credentials, ICE or router discovery. Existing direct/TURN traffic does not consume the application-relay payload budget.

Maintain one connection-generation arbiter for each peer. A replacement transport authenticates in a standby state; it cannot feed project frames until both endpoints acknowledge the handover generation. Freeze the old application send queue at the cutover, transfer pending intent to the current actor, reconcile state on the new path, then close the old generation. If acknowledgement fails, retain the healthy old route and retry with backoff. If the old route is dead, reconnect and reconcile rather than claiming lossless delivery of its in-memory ciphertext. Old callbacks cannot change the active generation. Serialize simultaneous upgrades with a deterministic device-ID tie break.

A WebSocket close invalidates application-relay sessions on that socket but must not tear down an independent healthy WebRTC connection. Reconnect signaling, restore authenticated subscriptions and negotiate new relay keys when needed. Vercel's current documentation supports WebSockets with Fluid compute, but connections are bounded by function duration and can reconnect onto other instances. This repository sets 300 seconds. See [Vercel WebSockets](https://vercel.com/docs/functions/websockets). An HTTPS-reachable endpoint is not proof that a network permits a WebSocket upgrade; HTTP long-polling/SSE client fallback is outside this revision.

### D13. Deployment budget, idle overhead and honest progress

The application relay requires no new hosted provider, paid TURN setup or billing automation. Its usable capacity is conditional on the actual Vercel/Upstash account plans, other application traffic and network access. Never auto-upgrade a plan or claim an unlimited free service. Publish deployment configuration for aggregate bytes, frame admissions, concurrent relay sessions and per-account/device fairness, with bounded expiring usage metadata shared across instances. Deployment controls override client limits.

Reserve small, short-lived batches of forwarding credits atomically before use; charge a conservative upper bound up front and do not refund unspent grants on crash, avoiding double-spend on reconnect. Include data, handshake, ACK/retry and routing overhead in the allowance. Hold a separate reserve for signaling/authentication so bulk traffic cannot evict healthy discovery. Credits are scoped to the authenticated server session and budget period; changing project, account connections or function instance cannot mint a new deployment allowance. If accounting is unavailable and no valid pre-reserved credit remains, reject further application forwarding with a retryable error. Rate-limit those errors too. Admission guards must also limit abusive inbound traffic before it creates backend work.

The shipped relay profile starts conservatively at 100,000 forwarded envelopes and 1 GiB of accounted relay traffic per rolling 30-day deployment window; these are application caps, not provider allowances or guarantees. Debit ingress, backend delivery and recipient egress conservatively, including encoding overhead. Use additional burst/concurrency/per-principal ceilings to avoid one sender consuming the entire reserve. Calibrate the command-cost multiplier and those ceilings against the actual backend in the first relay phase; refuse enabling the profile where measured baseline plus reserved relay load exceeds the configured provider headroom. Credits themselves, presence and authorization calls must appear in the measured budget. No-provider-cost mode requires operator confirmation of existing account headroom, not a new service account.

The current heartbeat is every 30 seconds per project and renews presence through Redis. With four projects on one device continuously active, the baseline is 4 * 30 * 24 * 3600 / 30 = 345,600 renewal requests in 30 days, before joins, tickets or content. Upstash's pricing page currently lists 500,000 commands/month on its free tier (checked 2026-10-11); this example is an invocation estimate, not a complete billing calculation. See [Upstash pricing](https://upstash.com/pricing/redis). Replace the existing deployment documentation's assumption that edits create no server traffic.

Batch compare-and-renew operations for sessions co-located on one function instance within the existing lease deadlines, and coalesce presence/small-update work without removing per-session ownership or extending authorization. Do not assume reconnects land on the same instance or that pipelining automatically reduces billable commands. Measure both co-located and distributed instances. If background demand exceeds budget, explicitly queue sessions with unavailable-seed status rather than silently allowing their presence to expire. Any projected free-tier sizing must include 24/7 idle seeds, not just interactive editing hours.

Application relay text/control traffic takes scheduling priority, but all traffic remains bounded: encryption prevents the server from proving that a client-declared priority lane actually contains text. Enforce hard combined limits regardless of that label; peers additionally enforce allowed message types and current roles. Permit assets within the remaining budget instead of silently excluding all binaries. If transfer or quota fails, keep the binary pending with its reason and retry condition, maintain the local copy and sync the portions that are available. A pure file-size cap is insufficient because text histories and initial document snapshots can also be large.

Connection time is a first-class budget: on Vercel an open socket keeps provisioned memory billed for as long as it lives. Report GB-hours and invocations next to Redis commands; cap application-relay socket time per window (`RELAY_SOCKET_SECONDS`, shared like the other credits) and keep the relay profile off by default. The idle baseline is eliminated by D14 rather than optimized; batched presence renewal (2.5) only lowers the cost of sockets that are open for an introduction or a relay session.

Expose direct WebRTC, TURN and application-relay routes distinctly, plus relay-limited state and independent UPnP state. Server acceptance, fragment ACK, durable local save and full-project reconciliation are separate observations. The existing successful-sync timestamp must not advance while a required asset is missing. Budget exhaustion never silently drops edits, disables a healthy direct link or claims an unavailable source is online.

### D14. Doorbell: zero idle cost, wake on demand

No device keeps a connection to the control plane while idle. The server only answers short requests and holds a signaling socket for the seconds an introduction needs (or for an application-relay session).

**Ring topics.** Each project has a push topic per membership epoch: `ht` + base32(HMAC-SHA-256(server ring secret, projectId | epoch)) truncated to 128 bits. The ticket response carries it, so members get it without another request, and it changes whenever the epoch changes (removal, demotion), so a removed member cannot ring the project again. The topic reveals neither project nor user.

**Subscription.** Every running client (the desktop supervisor for its retained and attached projects, a browser tab for its open project) keeps one subscription to the push channel for all its topics: ntfy over SSE/WebSocket, `https://ntfy.sh` by default, a self-hosted ntfy through `DOORBELL_URL`. This connection goes to the push service, never to our server. Subscriptions reconnect with jittered backoff; a client that cannot subscribe shows that its project is reachable only while open and otherwise behaves like today.

**Ringing.** A member that needs peers (opening a project with no connected peer, a newcomer, Sync now, reconnect after a lost mesh) calls `POST /projects/:id/ring`. After the usual membership check the server returns a ring token: compact Ed25519 JWS signed with the ticket key, claims `{ v, topic, ep, iat, exp = iat + 60 s, n }` (random nonce), nothing else. The requester publishes it to the topic itself (no message caching, no notification text), so push-service quotas such as ntfy.sh's per-IP daily message limit apply per member rather than to the server's egress address. One publish rings every subscribed device of the project. The server rate-limits ring tokens per device and project (one per 20 s, 60 per hour); the client rings only when it has no usable peer and debounces repeated needs.

**Waking.** A subscriber verifies the token offline (trusted ticket keys, exact topic of a project it holds, `ep` not older than its own epoch, unexpired, nonce unseen in a bounded window) and drops anything else without network activity. It then answers if it is not already in a mesh with someone, or if it is the lowest device ID of its current mesh (one representative per mesh). It waits a random 0-1.5 s, fetches a fresh ticket when needed, opens the signaling socket, and the existing hub and connection manager introduce the peers. A per-device wake budget (one wake per project per 10 s, 120 per hour) bounds what a leaked token or a misbehaving member can cost. Other mesh members are reached through peer exchange without the server.

**Introduction window.** A socket opened to ring or answer closes as soon as the wanted links are authenticated, or after 30 s; the gatekeeper role is removed. Presence leases remain the hub's introduction mechanism, and heartbeats only happen while a socket exists. Devices that are connected renew tickets as today (peer authorization needs fresh tickets); dormant devices renew nothing. An older client that still keeps a gatekeeper socket interoperates unchanged.

**Cost.** Idle: zero invocations, zero GB-h, zero Redis commands. One introduction: one ring request, one or two short ticket requests, one socket per answering party for about 10 s (≈ 0.006 GB-h each at 2 GB) and a few dozen Redis commands, plus one push publish. The free tier therefore scales with introductions per month, not with installed seeds.

**Privacy.** The push service sees topic names, timing and the IP addresses of subscribers and ringers. It never sees project content, project or user identifiers, or anything that authorizes a connection: peers still authenticate with tickets and device keys.

Alternatives: keeping sockets open (gatekeeper, always-connected seeds) costs provisioned memory continuously; periodic polling spends invocations per device and adds minutes of latency; Web Push needs a visible notification for every push in Chrome and does not exist in the desktop webview; public Nostr relays or BitTorrent trackers would remove even the introduction cost but give up control over authorization, abuse limits and reliability.

## Risks / Trade-offs

- [Server relay shares hosting quotas and introduces a new encrypted transport] -> Use explicit authentication and replay protection, recipient-only forwarding, bounded recovery and measured deployment-wide admission. No claim of guaranteed availability or unlimited free usage.
- [Larger install and a supervised process] -> Bundle a pinned runtime, sign/package it for every target, constrain IPC, and record idle/resource measurements. This cost purchases renderer-independent execution.
- [Desktop migration and UI bridge affect many data flows] -> Stage migration, keep source recoverable, test real legacy fixtures including journals/history, and gate rollout on editor/compile/folder parity.
- [Maintaining an ICE dependency patch] -> Keep the extension small and version-pinned; test LAN, STUN, TURN and mapped paths independently and track its upstream disposition.
- [UPnP cannot traverse every network] -> Keep relay fallback and accurate route diagnostics; do not claim guaranteed connectivity from a router acknowledgement.
- [More retained peers load signaling and local memory] -> Limit active projects, maintain heartbeat/ticket jitter, avoid duplicate identities, and expose queued availability.
- [An always-running seed may preserve sensitive local caches] -> Maintain account isolation and explicit disable/remove controls without changing the existing at-rest security model or promising encrypted disk storage.
- [Default viewer rights limit replica availability] -> Preserve current authorization; document that owner/editor seeds are required. Viewer replication needs a separate authenticated-provenance design.
- [OS sleep or expired authorization interrupts availability] -> Resume automatically when possible and report the actual unavailable state; never bypass OS power choices or ticket expiry.
- [Dependency on a free third-party push service] -> Open protocol and self-hostable (`DOORBELL_URL`); no secrets or content cross it; when it is unreachable, devices still connect while their projects are open and the status says so.
- [Push-service quotas: ntfy.sh allows about 30 open connections and 250 messages per day per IP] -> One subscription per device for all topics, one publish per ring for the whole project, rings only when no peer is usable; offices behind one address can point `DOORBELL_URL` at their own instance.
- [Wake latency] -> A dormant seed needs push delivery, a ticket and ICE; target p95 <= 10 s and show "waking" meanwhile.

## Migration Plan

1. Implement and verify the capability-negotiated application relay on the existing clients/server first, with independent enablement and measured free-tier budgets. Keep existing direct/TURN behavior and do not depend on tray, storage migration or UPnP.
1b. Land the doorbell (D14) on the current web and desktop clients: ring topics and tokens, the push subscriber, removal of the gatekeeper socket and the introduction window. Measure idle and per-introduction usage before building background seeding on it.
2. Land the portable core, native storage, supervisor and bridge behind a desktop feature switch. Reuse the relay adapter. Ship migration fixtures and verify target storage before enabling background ownership; never run both persistence writers for the same project.
3. Add tray/catalog controls and transport/UPnP behind independent switches; default UPnP on only once its real-network gates pass.
4. Package on all supported desktop targets and perform the acceptance matrix before enabling seeding by default for eligible retained projects.
5. Rollback can disable application-relay capability independently while preserving direct/TURN paths and endpoint data. Safe desktop feature rollback disables background demand and UPnP while keeping the new foreground adapter and authoritative store. A binary downgrade after new edits is not safe by merely reopening stale IndexedDB: require a verified reverse export/import or local project export first. Retained legacy databases are migration recovery sources, not continuously mirrored rollback copies.
6. Record validation commands, platform/version matrix, resource measurements, provider usage baselines, relay admission accounting, limitations and selected-route evidence in a verification document during implementation. Update README and docs for startup, pause versus background-disable, authorization outages, quotas, UPnP troubleshooting and recovery.

## References

- Local source files and installed Cargo 0.13.0 sources inspected for the audit above.
- [Tauri system tray](https://tauri.app/learn/system-tray/) and [autostart](https://v2.tauri.app/plugin/autostart/): native lifecycle integrations.
- [Tauri webview builder source](https://docs.rs/tauri/latest/src/tauri/webview/webview_window.rs.html): platform limits of background-throttling control.
- [Tauri external binaries](https://v2.tauri.app/develop/sidecar/): target-specific bundled executable packaging. Launch remains through this repository's native process helper rather than granting generic shell permissions.

