# Tasks

Implementation is authorized. Prefer peer-to-peer content delivery; the application relay is fallback only. Follow design.md decisions D1-D13 and the three delta specs. Implement groups 1-3 and 3B on the existing clients/server before the desktop migration and UPnP work. The control plane stays on free tiers: no task may add an idle connection, heartbeat, ticket renewal or poll for a device that nobody needs (D14). Preserve archived harden-realtime-peer-sync behavior throughout. Each group includes its own tests and documentation; group 13 is only cross-feature acceptance.

## 1. Relay authentication and transport binding

- [x] 1.1 Generalize PeerTransport authentication binding with an explicit relay variant while preserving the legacy DTLS transcript exactly; verify existing handshake tests and old/new WebRTC interoperability.
- [x] 1.2 Implement the D12 authenticated ephemeral relay handshake, canonical transcript and directional key derivation using existing reviewed primitives; verify mutual key confirmation and forged, substituted, reflected, invalid-key and wrong-project negative cases.
- [x] 1.3 Add authenticated relay envelopes with domain separation, unique nonces, bounded replay tracking and key destruction; verify cross-channel/session replay, out-of-order delivery, identical retransmission and counter-exhaustion behavior.
- [x] 1.4 Apply current ticket, role and epoch enforcement to relay setup and delayed work; verify expiry, demotion, removed members and copied-ticket attempts cannot authorize project traffic.
- [x] 1.5 Document and review the cryptographic transcript, threat model and WebRTC compatibility boundary; verify the review addresses every key/nonce/transcript lifetime and its corresponding regression test before relay production enablement.

## 2. Server relay routing, budgets and idle overhead

- [x] 2.1 Add optional relay capability negotiation and a distinct relay message family on the existing authenticated WebSocket; verify old clients/servers continue unchanged and unsupported payloads never bypass authentication or signaling limits.
- [x] 2.2 Implement recipient-specific environment/project/device/session Pub/Sub routing with confirmed subscription readiness and current recipient authorization; verify cross-instance delivery, replaced sessions, unknown recipients and cross-project rejection without project-wide payload fan-out.
- [x] 2.3 Preserve the 64 KiB encoded ceiling and add bounded socket queues, reserved control capacity and relay admission guards; verify oversized, burst and slow-recipient cases cannot starve signaling or retain unbounded ciphertext.
- [x] 2.4 Implement D13 aggregate/per-principal byte, envelope and concurrent-session budgets with atomic pre-reserved credits, bounded metadata and accounting-failure behavior; verify competing instances, reconnects, expired grants and budget-period transitions cannot overspend the application allowance.
- [x] 2.5 Add usage instrumentation and batched ownership-preserving presence renewal for co-located sessions; verify per-session expiry/revocation, real-Redis parity and command counts for both co-located and distributed sessions.
- [x] 2.6 Measure idle seeds, handshake, ACK/retry and content costs against actual hosting limits and configure conservative headroom before enabling the relay profile; verify a reproducible usage report includes four always-on projects and estimates beyond payload bytes alone.
- [x] 2.7 Document transient-ciphertext handling, deployment configuration and free-tier limits; verify database/log inspection contains no payload archive or plaintext, and replace deployment documentation claiming edits never produce server traffic.

## 3. Client relay delivery, fallback and route changes

- [x] 3.1 Implement the shared browser/desktop application-relay adapter on current clients without requiring the future desktop worker, UPnP or TURN credentials; verify capable peers start relay setup within 10 seconds when no WebRTC path is usable.
- [x] 3.2 Add bounded fragmentation, per-channel ordering, authenticated ACKs, credit flow and retransmission with separate custody/durability/reconciliation states; verify lost, duplicate, reordered and stalled messages never falsely complete project sync.
- [x] 3.3 Recover from signaling duration limits, Pub/Sub subscription failure and instance replacement using fresh relay sessions and endpoint reconciliation; verify 300-second rotation, fresh keys, binary retry and preserved offline work.
- [x] 3.4 Add the per-peer route-generation arbiter and coordinated relay/direct handover; verify simultaneous attempts, lost handover acknowledgement, stale callbacks and concurrent text/blob activity preserve one active owner and all durable edits.
- [x] 3.5 Prioritize text/control within combined relay budgets, defer assets when limited, and keep unrelated direct links running; verify quota exhaustion, misleading priority labels and unavailable accounting produce accurate pending states and bounded retry.
- [x] 3.6 Expose direct WebRTC, TURN, application relay and relay-limited states in current client sync UI; verify text-complete/image-pending does not advance full-project completion and existing UPnP state stays independent.
- [x] 3.7 Document route selection, limited relay capacity, optional TURN and no-source behavior; verify browser/browser and desktop/browser scenarios with direct connectivity and TURN disabled before starting the desktop migration.

## 3B. Zero-idle doorbell on current clients (D14)

- [x] 3B.1 Derive per-project, per-epoch ring topics from a server ring secret and return them with tickets; add `POST /projects/:id/ring` issuing signed short-lived ring tokens after the membership check, with per-device/project rate limits; verify topic rotation on epoch change, removed-member denial, token claims carry no project/user identifiers, and limiter behavior.
- [x] 3B.2 Add a shared push-channel subscriber (ntfy SSE adapter behind an injectable interface, `DOORBELL_URL`, one connection per device for all topics, jittered reconnect) and offline ring-token verification with nonce replay window, epoch check and per-device wake budget; verify forged, expired, replayed, wrong-topic and old-epoch tokens cause no network activity.
- [x] 3B.3 Replace the always-on gatekeeper socket with ring-driven introductions: ring when no usable peer exists, answer as unmeshed device or mesh representative with jitter, close the signaling socket once links authenticate or after the 30 s window; verify no idle socket after linking, a late joiner reaches an existing mesh through one representative, three-device convergence and interoperation with an older gatekeeper client.
- [x] 3B.4 Limit ticket renewal to connected or attached sessions and fetch tickets on wake; verify a dormant client makes zero control-plane requests over a long idle period and a woken one authenticates with a fresh ticket.
- [x] 3B.5 Make the application relay wait for a configured TURN attempt and close relay sockets with their sessions; add a relay connection-time budget; verify TURN-configured peers do not start relay setup while TURN is still being tried and relay sockets do not outlive relay sessions.
- [x] 3B.6 Expose reachable-on-ring, waking and ring-channel-unreachable states and make Sync now ring; verify UI states and that editing continues when the push channel is down.
- [x] 3B.7 Extend the usage report with invocations, provisioned-memory GB-hours and push messages for idle devices and per introduction, comparing the gatekeeper and doorbell models; document the doorbell, `DOORBELL_URL`, ntfy limits and privacy in deployment, protocol, security and README.
- [x] 3B.8 Run browser/browser and desktop/browser acceptance against a local ntfy-compatible push server: a socketless open client and a dormant desktop are woken by a ring, sync, and return to no server connection; record p95 ring-to-link time.

## 4. Portable synchronization core and lifecycle registry

- [x] 4.1 Extract framework-neutral synchronization and ticket-recovery logic from ProjectSession with injected storage, identity, API, clock and transport adapters; verify existing mesh, offline-fork, sync-status and connection unit suites still pass.
- [x] 4.2 Implement the server/account/project registry with shared initialization, attachment leases, demand tracking and generation cancellation; verify concurrent opens, detach-before-open-completes, pause-during-open and stale-close tests.
- [x] 4.3 Separate compiler/election, backup and folder services from sync-only startup; verify a background actor invokes none of those services and foreground attachment preserves their existing behavior.
- [x] 4.4 Add browser adapters, reuse the phase-1 application relay and preserve workspace-scoped browser shutdown; verify web realtime, relay fallback, offline-merge and navigation regressions without a desktop runtime.
- [x] 4.5 Document runtime ownership, adapter contracts and stop versus detach semantics in developer documentation; verify documented state transitions match the registry tests.

## 5. Native persistence and migration

- [x] 5.1 Add a scoped native SQLite Persistence adapter with atomic document/metadata transactions, durable commits and bounded blob staging; verify the persistence contract suite plus transaction rollback, compaction and hash-rejection cases.
- [x] 5.2 Add native ingress journaling and idempotent edit-sequence acknowledgements; verify worker termination between custody, application and durable acknowledgement neither loses nor duplicates edits.
- [x] 5.3 Implement full IndexedDB export/import including metadata, completeness, offline checkpoints, snapshots and change sets; verify legacy 0.5.0 fixtures compare equal after reopening the target.
- [x] 5.4 Add migration lock, checkpoint manifest, checksums, atomic active-store switch and ambiguous account/server handling; inject failures at every transition and verify resumable recovery with the original source intact.
- [x] 5.5 Route desktop copy/publish/link/delete/export and local-only project flows through the persistence abstraction; verify local-mode, import, history, publish and deletion scenarios without a second desktop writer.
- [x] 5.6 Document migration status, local recovery export and safe feature rollback versus binary downgrade; verify the documented recovery procedure on an interrupted fixture.

## 6. Headless worker and native supervision

- [x] 6.1 Bundle the sync worker for a pinned Node runtime and implement typed, versioned pipe IPC with frame limits, request IDs, generations and cancellation; verify a no-DOM worker starts and malformed/oversized/obsolete messages are rejected.
- [x] 6.2 Launch only the fixed bundled worker through proc::background_command, clear runtime-injection environment, and constrain native dispatch; verify hidden launch and existing no-generic-shell/filesystem permission checks.
- [x] 6.3 Implement supervisor restart/backoff, pipe EOF shutdown, Windows job ownership and Unix parent-lifetime handling; verify worker crash, parent termination and repeated crash tests leave no orphan process or peer connection.
- [x] 6.4 Route native RTC, application relay and storage events to the current worker generation with bounded queues; verify two projects sharing a remote device ID cannot collide and old callbacks cannot mutate a replacement runtime.
- [x] 6.5 Document the worker/native protocol and diagnostic redaction; verify protocol examples with the IPC harness and inspect fixtures for secret-free logs.

## 7. Editor and foreground-service attachment

- [x] 7.1 Implement snapshot/state-vector attachment with a revision barrier and buffered deltas; verify remote edits during attachment and renderer reload converge without gaps or echo loops.
- [x] 7.2 Bridge editor Yjs updates and file/undo/import/restore commands through actor authorization and durable acknowledgements; verify typing, undo, change attribution and save-error behavior including a worker crash with pending input.
- [x] 7.3 Connect offline-conflict presentation and revision-checked resolution to the actor; verify renderer reload, stale resolution, interrupted merge and demotion cannot publish obsolete or forbidden work.
- [x] 7.4 Adapt foreground compilation and GitHub backup to the authoritative runtime without another mesh/store; verify compile-mode and backup authorization suites plus cancellation on last-editor detach.
- [x] 7.5 Adapt folder binding to foreground leases and safe reopen reconciliation; verify external edits made while only seeding do not publish until the existing folder merge runs.
- [x] 7.6 Clear cursor/file awareness on last-editor detach and add optional seed availability; verify updated presence UI and interoperability with peers ignoring the optional fields.
- [x] 7.7 Document editor/background behavior and folder/compile/backup boundaries; verify user instructions against desktop attachment tests.

## 8. Catalog, authorization, recovery and resource policy

- [x] 8.1 Persist scoped retained-project selection, default owner/editor seeding as dormant ring-reachable seeds, explicit Download and seed, and background-disable versus pause; verify untouched memberships stay undownloaded and background activation does not change recents.
- [x] 8.2 Add awaited local stop barriers for logout, account/server switch, local mode, removal and role demotion; verify delayed API/RTC responses cannot restart stopped sessions or expose another account's cache.
- [x] 8.3 Integrate OS keychain credentials, stable device identity, trusted keys, the background doorbell subscription and ticket fetch on wake (no renewal while dormant); verify locked-keychain, offline-startup, expiry, epoch change and server recovery cases without memory-only seed identities.
- [x] 8.4 Add native network/resume signals and persistent pause enforcement, re-subscribing the doorbell after resume; verify recovery begins within 30 seconds of a healthy resume and explicit Work offline survives restart.
- [x] 8.5 Implement background hydration of all known text and referenced binaries with current-reconciliation checks; verify a seed supplies a newcomer after the author leaves and missing assets stay partial and retryable.
- [x] 8.6 Implement D8 scheduling of awake projects (dormant seeds unlimited), transfer priorities, concurrency/rate/receive-buffer budgets and disk reserve; verify queue fairness, no starvation, storage-full recovery and that unsaved/recovery data is never evicted.
- [x] 8.7 Document seed eligibility, viewer limits, ticket-expiry outages, quotas and pause controls in README and sync/security documentation; verify each documented status has a matching tested state.

## 9. Native desktop RTC and mapped ICE candidates

- [x] 9.1 Make desktop WebRTC paths use native RTC through the worker bridge while both platforms retain the shared application-relay adapter; verify native/browser authentication, data-channel ordering, trickle, backpressure and cancellation parity.
- [x] 9.2 Add reference-counted interface-scoped UDP mux listeners and network generations; verify several project connections share a bound listener and closing one does not break the others.
- [x] 9.3 Add the version-pinned ICE extension for verified mapped endpoints backed by the actual mux socket, retaining host/STUN/TURN candidates; verify packet-level same-port mapped-candidate connectivity and no unsupported SDP-only injection.
- [x] 9.4 Expose selected candidate-pair diagnostics and safe generation replacement for invalid mappings; verify LAN without hairpin, ordinary STUN, IPv6 where supported, TURN-only and application-relay operation and stale-candidate retirement.
- [x] 9.5 Document the exact transport patch, its tests and upstream disposition in dependency notes; verify the lockfile pins the tested source and a clean dependency build includes the patch.

## 10. UPnP mapping lifecycle

- [x] 10.1 Add a pinned reviewed IGD client behind a bounded, mockable Rust gateway adapter with default-route selection and response/URL validation; verify malformed XML, oversized replies, off-network URLs, redirects and unavailable gateway cases.
- [x] 10.2 Implement owned same-port UDP mapping creation/verification with finite leases and at most three conflict alternatives; verify existing third-party mappings remain untouched, different-port offers fall back and permanent-only gateways are unsupported.
- [x] 10.3 Feed only verified current mappings into the socket-backed ICE extension while ordinary ICE proceeds; verify UPnP direct traffic with TURN disabled and timely STUN/TURN or application relay fallback after rejection or ineffective mapping without interrupting a healthy relay.
- [x] 10.4 Implement finite-lease renewal, public-address/gateway revalidation, bounded retry and per-listener reference counts; verify long-running renewal, gateway reset, several projects and changed network tests.
- [x] 10.5 Implement disable/pause/logout/last-session/quit cleanup and compensation for late AddPortMapping results; verify ownership checks, three-second cleanup deadline, crash lease expiry and no late reactivation.
- [x] 10.6 Add independent mapping and selected-route status plus secret-free diagnostics; verify mapped-but-TURN, mapped-but-application-relay, unsupported, disconnected and disabled states cannot report a false direct connection.
- [x] 10.7 Document UPnP controls, router incompatibility, CGNAT/double NAT, host firewall limits and lease cleanup; verify troubleshooting examples against the emulated-router test matrix.

## 11. Tray, startup and desktop controls

- [x] 11.1 Add narrow native tray and single-instance integrations with show/open, close-to-background and explicit Quit; verify close/reopen, second launch and no-tray fallback on supported desktop platforms.
- [x] 11.2 Add user-selected launch-at-login and start-in-background settings with persisted state; verify login startup restores eligible sessions without an editor and disabling startup removes the registration.
- [x] 11.3 Add global/project pause and seed selection, resource settings and project status views; verify UI scenarios distinguish dormant, waking, ring channel unreachable, queued, partial, relay-limited, auth-required, offline, save failure and unresolved conflict.
- [x] 11.4 Integrate durable quit, bounded OS shutdown, updater restart and helper pairing window restoration; verify failure-to-save offers recovery, an update does not duplicate a seed and browser-requested pairing opens a visible window.
- [x] 11.5 Document tray actions, login startup and platform tray limitations; verify accessibility labels and that every documented action is reachable with keyboard navigation.

## 12. Packaging and release readiness

- [x] 12.1 Package the pinned worker runtime and script resources for every shipped desktop target, including signatures/checksums and license notices; verify a clean machine with no installed Node can launch the worker.
- [ ] 12.2 Extend desktop CI build/e2e setup for native persistence, patched ICE and worker artifacts without weakening existing CSP/process guards; verify clean Windows/Linux builds and a packaged macOS startup check.
- [x] 12.3 Implement independent rollout switches and safe disable paths for application relay, background demand and UPnP; verify foreground data remains current after feature rollback and a downgrade cannot silently reopen stale IndexedDB.
- [x] 12.4 Document release packaging, manual macOS checks and rollback commands; verify the procedures on built artifacts and record exact dependency/toolchain versions.

## 13. Cross-feature acceptance

- [x] 13.1 Run no-renderer, two-project desktop-to-browser bootstrap/edit scenarios, then pause, logout and restart; verify complete text/assets, accurate presence and one runtime per scoped project.
- [x] 13.2 Run the 60-minute background soak alternating dormant periods (zero control-plane requests) and wake cycles across ticket/relay refresh, mapping renewals, sleep/resume and network changes; record bounded CPU/RSS/handles/queues and absence of reconnect leaks in verification.md.
- [x] 13.3 Run seven-peer typing with background hydration and the existing 12-peer convergence/duplicate-relay checks over direct and application-relay paths with sufficient configured budget; record p95 against the <=250 ms healthy-network contract and label quota-limited runs separately.
- [x] 13.4 Run mapped direct, no-hairpin LAN, unsupported-UPnP and relay-only matrices against packaged desktop/browser peers; retain selected-pair and packet evidence that distinguishes a SOAP success from working transport.
- [x] 13.5 Run migration, worker/renderer crash, disk-full, offline-merge and viewer/revocation integration fixtures; verify durable recovery, no unauthorized publication and no stale-generation resurrection.
- [x] 13.6 Run appropriate workspace checks and OpenSpec strict validation, and record exact commands, platform coverage and any remaining limitations; verify every required scenario has evidence before marking implementation complete.

- [x] 13.7 Run application-relay-only tests across web and packaged desktop with direct/TURN blocked, payload loss, 300-second socket rotation and cross-instance replacement; verify endpoint recovery and authenticated delivery without a new hosted service.
- [x] 13.8 Run relay/direct handover during simultaneous edits and asset transfer; verify current-generation ownership, unchanged authorization and no missing work after cutover.
- [x] 13.9 Run aggregate budget exhaustion, unavailable accounting and idle-presence load across multiple instances/accounts; record measured command/byte/function invocation and GB-hour usage, bounded overshoot and continued healthy direct traffic.
- [x] 13.10 Run relay cryptographic negative and no-payload-retention checks together with viewer/revocation integration; verify replay, wrong-context and expired-key traffic cannot mutate or disclose project data.
