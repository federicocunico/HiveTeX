# Design

## Context

See `proposal.md` for motivation. Audit date: 2026-10-11. Audited baseline: `e5308d31d33b5c33dc10d1e10d8b72adc3f8e3d0`; the working tree was clean before this planning change.

HiveTeX uses a Yjs root document for the file table/settings and lazy per-file documents, IndexedDB persistence, authenticated WebRTC sync/bulk channels, a signaling gatekeeper, and content-addressed binary transfer. `OfflineFork` temporarily replaces locally edited documents with their shared base before a line-based three-way merge. `ProjectSession` connects this machinery to CodeMirror, folder mirroring, compile leadership, history, export, and GitHub backup.

### Audit coverage and evidence

Read the implementation and nearby tests for authentication, framing, browser/native transport adapters, mesh relaying, connection retries, signaling presence, TURN credentials, local persistence, offline merging, file identity, synchronization status, folder mirroring, editor binding, compile snapshots, and backup collection. Read the corresponding main specifications, CI workflow, and performance/security documentation. This was a deep audit of the collaboration path and its downstream consumers, not an exhaustive review of every repository subsystem.

Executed against the unmodified implementation:

- `pnpm --filter @hivetex/sync test`: **13 files, 97 tests passed**.
- `pnpm --filter @hivetex/server exec vitest run test/signal.test.ts test/p2p-e2e.test.ts`: **2 files, 18 tests passed**.
- Isolated in-memory probes through `pnpm --filter @hivetex/sync exec tsx --input-type=module -`, using the existing classes, memory stores, and fake transports/filesystems/GitHub clients. No remote GitHub mutation or production connection was made.

The probes deliberately inspect internal state where needed; they establish concrete failure mechanisms, not full browser or production incidents. The first connection probe had an incomplete fake RTC interface and was corrected before reporting results. A compile snapshot probe did not exercise the intended ordering because the binary sorted before the text; the mixed-snapshot issue below is therefore source-traced, not dynamically confirmed by that probe. Browser E2E, real TURN/NAT paths, native application execution, and dependency advisory scanning were not run in this audit. No assertion is made that those environments are currently passing or secure.

### Prioritized findings

P1 means data loss, authorization failure, or a core workflow failure that deserves the first implementation tranche. P2 means a significant reliability or correctness defect with a narrower trigger. **Probe** means an isolated execution reproduced the stated mechanism; **Trace** means the source path was inspected and a regression test is still needed. Source references below are baseline repository paths and line numbers.

| ID | Priority | Evidence | Finding |
| --- | --- | --- | --- |
| F01 | P1 | Probe | A failed persistence append poisons every later flush |
| F02 | P1 | Probe + trace | Offline document replacement starts before recovery data is durable |
| F03 | P1 | Probe + trace | Merge timeout and preparation failure are treated as success |
| F04 | P1 | Probe | Duplicate cleanup deletes not-yet-received files |
| F05 | P1 | Probe | Any member can invent the enforced membership epoch |
| F06 | P1 | Probe + trace | Missing backup assets become remote deletions |
| F07 | P1 | Trace | Offline startup cannot recover its temporary device identity |
| F08 | P2 | Trace | Idle signaling presence expires before socket rotation |
| F09 | P2 | Trace | TURN credentials and initial acquisition failure are cached indefinitely |
| F10 | P2 | Probe + trace | Duplicate connection setup survives stop and can orphan attempts |
| F11 | P2 | Probe | Backpressured sends never settle when a channel closes |
| F12 | P2 | Probe + trace | Fragment assembly and blob byte retention lack complete bounds |
| F13 | P2 | Trace | Historical receipt and count-based retry keys misreport current synchronization |
| F14 | P1 | Probe + trace | Compile identity excludes settings and can describe different input bytes |
| F15 | P1 | Probe + trace | Matching folder binding leaves no merge baseline; initial viewer binding mutates content |
| F16 | P2 | Trace | Editor loads can complete out of order or after destruction |
| F17 | P2 | Trace | Backup completion clears edits made while uploading |
| F18 | P2 | Trace | Delayed document application and reconnection lose authorization ordering |

#### F01: A failed write permanently stops saving

`packages/sync/src/persistence.ts:288` removes `pending` before awaiting `append`, then retains the rejected `flushing` promise. Subsequent `.then(...)` callbacks never run. The probe inserted A, failed the first append, inserted B, and flushed again: `appendCallsAfterTwoFlushes=1`, `pending=1`. A is no longer queued and B cannot be saved through that persister. The timer invokes `flush()` without handling rejection; the session exposes no persistent save-error state. A quota or transient transaction failure can therefore leave the editor apparently usable while edits cease to be durable.

Regression: fail the first append and separately the first compaction, restore storage, flush later edits, reopen a fresh model, and require both old and new text. Check the user-visible unsaved state.

#### F02: Offline recovery is not crash-atomic

`fork.ts:239` calls `model.replaceDoc` before writing `fork:mine:*` at line 242 or the merging record at line 243. `model.ts:133` swaps the document synchronously and starts replacing persistent updates. The probe recorded `replacingBeforeRecovery=true`. A crash or failed metadata write in that interval can leave the base saved where the only durable offline version used to be. At completion, `fork.ts` also clears checkpoints without first guaranteeing durability of the result across documents. Metadata is written through separate transactions; `beforeChange` launches untracked writes, and `discard()` does not await an earlier append already in flight.

Regression: interrupt after each durable transition, create a new model/fork over the same store, and assert the exact offline text is recoverable once. Include slow writes, failed metadata, pending compaction, and edits during preparation.

#### F03: Missing remote state is accepted as a merge input

`fork.ts:meshWaitSynced` uses the same `finish()` for receipt, timeout, and `openDoc` rejection. A fake peer that never sends anything still produced `SYNC_TIMEOUT {resolved:true,receipts:0}`. `merge()` proceeds using its local base as theirs and eventually clears the fork. Late overlapping edits can then meet already-published changes without the specified conflict decision. A separate probe gave a mesh a rejecting `beforeSync`: `mesh.ts:184` swallowed the error and the remote peer received `private-offline.tex` anyway. These are distinct routes around the same safety boundary.

Regression: delay root and file responses beyond the deadline; disconnect between root and file receipt; reject preparation; ensure the fork stays pending and private work is not exchanged by the failed attempt. Then reconnect and resolve the actual conflict.

#### F04: Unknown content is mistaken for identical empty text

`model.ts:383` opens both documents and compares their strings without checking receipt. `session.svelte.ts:290` schedules this cleanup 2.5 seconds after file-table changes. The probe created two same-path entries without loaded bodies and observed `removed=1, remaining=1`. On a slow join, both temporary documents can read empty although the remote bodies differ; the deletion then propagates. Awaiting comparisons also permits a file to change before its entry is removed.

Regression: deliver a duplicate-path root first, withhold two different bodies beyond the cleanup delay, and assert both file identities survive. Revalidate revisions after asynchronous comparison.

#### F05: Unsupported epoch gossip can evict honest members

`mesh.ts:363` accepts any finite number from `EPOCH`; `noteEpoch` applies it to policy and rebroadcasts it. `VIEWER_ALLOWED` includes EPOCH. A viewer whose verified ticket epoch was 1 moved the owner's enforced epoch to 1,000,000,000 in the probe. Genuine tickets cannot catch up, so grace-period expiry can disconnect honest members and later reconnections fail stale-epoch checks. Merely constraining the number to an integer does not fix the authority problem. `refreshOwnTicket` also broadcasts without advancing the sender's own verified epoch locally.

Regression: invented epochs, wrong-project evidence, expired evidence, valid newer tickets, and local owner refresh. Only verified authority may advance policy.

#### F06: Skipped backup blobs are deleted, contrary to the comment

`packages/github/src/agent.ts:254` catches failed binary fetches and omits them, with a comment saying they stay on GitHub. `backup.ts` deletes previously managed paths absent from the collected map. A fake GitHub client with a previous manifest containing `fig.png` produced `deleted=1, figureDeletion=true` when the collected map omitted it. This confirms the deletion rule; the source trace connects it to failed acquisition. Text consumers have the related problem that `mesh.prefetchAll()` only sends requests; it does not await bodies. Backup, export (`Workspace.svelte:323`), and compilation can read empty placeholders.

Regression: a missing image still present in the root must prevent the remote update; an intentional root deletion must still be backed up. Delay text bodies and check export/backup contents.

#### F07: Offline startup gets stuck using an unregistered identity

`session.svelte.ts:163` wraps registration and `/keys` loading in one catch and replaces even a usable existing identity with an `offline-*` device. `refreshTicketLoop` later requests a ticket for that temporary ID, without retrying registration or trusted-key setup. `startManager` explicitly refuses `offline-*` IDs at line 753. Returning network access therefore does not restore collaboration in that session. A 403 may additionally mark this temporary bootstrap failure as revoked. This is different from the explicit local mode, which `api.ts` correctly guards against server requests.

Regression: cached project and device, `/keys` initially unreachable, then network restored; assert automatic registration/trust/ticket recovery and merge without reopening.

#### F08: Idle peers disappear from discovery

`server/src/signal/hub.ts:114` sets presence TTL to 90 seconds; it renews only on auth or client `ping`. `ConnectionManager` sends no signaling heartbeat and rotates at 280 seconds. Its mesh APP pings do not renew server presence. After expiry, a lower-ID newcomer receives no older peer in `ready`; the older higher-ID peer sees the join but does not initiate, delaying connection until rediscovery. `MemorySignalBackend` ignores TTL, so current integration tests cannot exercise this. The production Redis implementation expires the entire project hash, not individual device leases, which can also keep dead entries around while another entry renews the hash.

Regression: expiry-aware backend, idle beyond 90 seconds, late join for both ID orderings; test old-session heartbeat/cleanup against replacement sessions.

#### F09: TURN acquisition never refreshes

`connect.ts:345` caches a promise for the manager's entire lifetime, including a failure converted to `[]`. `/turn` issues one-hour credentials and returns `expiresAt`, but `session.svelte.ts:773` drops the expiry. Later connection attempts can repeatedly reuse expired credentials; an initial acquisition failure prevents relay recovery until manager recreation. A stalled acquisition also precedes the link timeout itself.

Regression: advance a fake clock beyond expiry, fail the first acquisition, and hang acquisition past its deadline. Subsequent relay-dependent attempts must obtain a usable fresh configuration.

#### F10: Setup and shutdown do not share ownership

`maybeConnect` checks `links` before `createLink` awaits ICE, but the entry is inserted only after that await. Two announcements can create two attempts. Stop does not invalidate the continuation. The probe announced one device twice, stopped, then resolved ICE: `factories=2, createdAfterStop=1`. The overwritten attempt is not owned by the map. Similar lifecycle hazards exist in old WebSocket callbacks, untracked retry timers, retained mesh subscriptions when managers are recreated, and ticket requests that finish after session close. These latter paths are traced, not separately reproduced.

Regression: deferred ICE, duplicate announcements, pause/resume, navigation, and delayed old-session callbacks; count transports, subscriptions, timers, and signaling after stop.

#### F11: Closed transport leaves pending promises alive

`transport.ts:53` waits only for `onbufferedamountlow`. Closing a full channel need not fire it, so the send chain stays blocked. The probe closed a fake channel above the high-water mark and observed `settled=false`. Blob deadlines do not help while their loop is itself awaiting a blocked send. Native `BridgeChannel.send` additionally catches IPC failures without reliably notifying the owning connection.

Regression: close/error while draining and while native IPC is pending; all sends must reject promptly and remaining peers must continue exchanging edits.

#### F12: Byte limits do not cover the full receive path

`transport.ts:94` accumulates fragments without a byte cap, sequence validation, or assembly timeout. Limits in `frames.ts` cover decompressed output, not raw reassembly. `blobs.ts:155` limits declared chunk count but not chunk bytes or aggregate retained size. A probe accepted 16,321 bytes for a chunk whose protocol limit is 16,320. A plausible count therefore does not ensure the advertised 50 MiB file limit. `serve()` also needs numeric finite range checks; malformed APP/control collections need bounded schemas rather than type casts.

Regression: oversized individual chunks, cumulative overflow, invalid fragment sequence, incomplete streams, raw oversized messages, and malformed request ranges. Use small configurable budgets in tests; do not allocate attack-sized buffers.

#### F13: Current sync is inferred from historical availability

`sync-status.ts:175` counts any stored document, nonempty loaded document, or historical receipt as available. `received` is not scoped to a reconnection; `rootKnown` can stay true after a link changes. `syncNow` waits for request dispatch and a tracker refresh, not completion. `lastFetchKey` uses only peer count and missing/total counts, so a new hash, replacement peer, or late blob announcement can leave a previously failed fetch unretried. Receipt activity for one file also resets the global stall clock for another missing file.

Regression: reconnect with stale cached files, manual sync with delayed responses, same-count peer replacement, same-count changed asset, and late availability after failure. Separate local availability, durability, and reconciliation in assertions.

#### F14: PDF identity can be wrong even when compilation succeeds

`pipeline.ts:computeStateHash` includes paths and contents but omits engine and main-file settings. The probe changed both and observed `hashUnchanged=true`; `run()` can reuse the prior successful result. Separately, `snapshot()` reads file contents over several awaits and then computes a hash by rereading the live model at line 145. If a text edit arrives while a later asset fetch waits, the result can carry a newer state's hash despite having compiled older text. This ordering case is source-traced; the first probe did not hit it because of file ordering.

Regression: settings-only changes and a deferred `zzz.png` fetch after `main.tex` capture, with a text edit while that fetch waits. Assert the hash matches captured bytes/settings, not the later live model.

#### F15: Mirror baseline and initial permissions are incomplete

`mirror.ts:221` skips matching initial text, and `writeEntry` returns for equal hashes before establishing its CRDT baseline. `mergeDiskText:383` then uses whole-file replacement when no baseline exists. The probe bound matching `BASE`, added `REMOTE ` to the project, then imported disk `BASE LOCAL`: `basesAfterEqualBind=0` and final text `BASE LOCAL`, losing the remote insertion. Initial reconciliation also calls `importFile`/`applyTextDiff` without the viewer guard used by later disk events, and persisted-base reconciliation ignores patch failure flags. Missing text can reach disk through the non-waiting prefetch path.

Regression: equal initial bind followed by concurrent changes; viewer bind with changed/new files; unknown content; overlapping edits after restart; disk write failure with retry. Never advance the baseline before a successful write or verified equality.

#### F16: Editor mounts have no generation guard

`Editor.svelte:mount` destroys the current view, awaits `openDoc`/`openText`, then creates a new view without checking that the file, session, or component is still current. Rapid selection can let A finish after B; destruction does not invalidate the pending mount. Ordinary remounting destroys the view but not the old undo manager. The replacement observer can start another mount concurrently.

Regression: controlled delayed loads resolving in reverse order, replacement during load, close during load, and repeated file switches. Assert one editor, the selected document binding, and no retained undo managers.

#### F17: Backup completion erases concurrent dirty accounting

`agent.ts:225` collects input and uploads it, then at line 235 unconditionally zeros `changesSince`, contributors, and first-change time from the latest shared metadata. Changes that arrived during upload were not necessarily captured, but lose scheduling/accounting. A next backup may wait indefinitely for a further edit. Use a captured revision boundary instead of clearing all current work.

Regression: defer the fake GitHub update, make another edit, complete the upload, and verify the new edit still triggers a second backup with its attribution.

#### F18: Authorization can become stale during asynchronous handling

`PeerConnection.dispatch` checks role, then invokes a `void` handler; `Mesh.onFrame` awaits the sync gate and document loading independently. Ticket refresh/close can overtake that work, whose final apply lacks a current-connection/role check. `onTicketRefresh` prevents rollback only inside one connection; a reconnect starts without that device's previous ticket watermark, and stale-epoch grace can temporarily admit the old ticket. Tests cover replay within one connection, not the reconnect path.

Regression: hold document loading, downgrade/close/replace the peer, release the load; also reconnect with an older editor ticket after a newer viewer ticket. Assert no unauthorized apply or forward.

### Specification tensions and deferred boundaries

- `peer-sync` says initial state can come from any online peer, but `VIEWER_ALLOWED` blocks STEP2/UPDATE and blob serving from viewers; `docs/security.md` explicitly documents that viewers cannot bootstrap newcomers. A viewer also cannot transparently relay editor updates under the current immediate-sender authorization model. Preserve viewer rejection in this change. Report lack of an eligible source accurately; adding authenticated provenance for viewer relays/bootstrap requires a separate protocol proposal.
- The existing conflict-resolution Viewer scenario explicitly discards offline differences after loss of edit rights, while Offline editing says work is never lost. This proposal does not silently change that product policy. Durable recovery applies to authorized offline work and failures; changing retention after demotion needs a separate decision.
- One stored device identity is shared by same-profile tabs (`keys.ts`), while the mesh replaces connections with the same device ID and has no tab coordination. This is a credible multi-tab divergence/lifecycle risk, not reproduced here. A separate proposal must choose shared-worker/leader-tab ownership versus distinct session identities and cover cross-tab persistence. No claim of seamless multi-tab support is added here.
- Native Rust filesystem/compiler internals, account race conditions, dependency advisories, platform-specific IME/undo behavior, and internet-path latency remain outside the completed audit. The native RTC adapter must participate in the transport regression work in this change.

## Goals / Non-Goals

**Goals:** Establish one durable recovery boundary, one explicit content-readiness contract, and one cancellable ownership model that downstream features can rely on. Turn the findings above into focused regression cases. Retain the existing seven-browser/12-peer healthy-link performance contracts and full-mesh relay efficiency.

**Non-Goals:** Replace Yjs, introduce server-hosted documents, change viewer edit rights, promise convergence with unreachable devices, redesign the compiler sandbox, add CRDT author signatures, or make broad dependency upgrades. No implementation is authorized by this planning workflow.

## Decisions

### D1. Recoverable persistence and a versioned merge journal (F01-F03)

Keep batching, but retain failed batches until append commits, recover the promise chain, and surface save state through a subscription. Retry with bounded backoff and coalesce retained updates; a permanent failure remains visible and permits recovery export. A failed compaction must not discard committed append data. Document replacement must join the same serialized storage lifecycle as pending writes.

Add an atomic persistence operation spanning updates and metadata where a merge transition needs it. Persist a versioned journal containing the base, mine, affected IDs, and operation ID before any destructive replacement. Advance explicit prepared/reconciling/committed stages; retain the journal until merged documents or conflicts and their outcome are durably committed. On startup, replay transitions idempotently. Capture snapshots synchronously and retain subsequent edits in the active generation instead of allowing asynchronous preparation to lose keystrokes.

Do not swallow preparation errors in `syncGate`: a failed attempt closes or suspends its document exchange, exposes a recovery error, and retries from the journal. Peer discovery/presence may continue while content exchange is safely pending. Avoid a global inbound queue that waits for the very fork-control message needed to release its gate.

Alternative rejected: extending timeouts or adding `.catch()` alone. Neither creates crash atomicity nor restores the removed batch.

### D2. Availability and reconciliation are separate contracts (F03-F04, F06, F13)

Track local completeness separately from local durability and current peer reconciliation. Scope receipt to connection generation, document ID, and request/round; only a confirmed response to a current request may complete that round. Incremental updates and merely having some Yjs structs are insufficient: pending dependencies can exist and state vectors alone do not prove all deletion information was exchanged.

Retain nonblocking `openDoc` for interactive viewing. Introduce an explicit awaitable operation for required document/snapshot readiness, with cancellation and distinct timeout/unavailable results. Do not redefine every `prefetchAll` caller implicitly; migrate complete-state consumers deliberately. A complete local copy remains usable offline, without claiming that offline content is current with absent peers.

Use negotiated capability/control messages for correlated receipts where supported. Retain legacy STEP1/STEP2 encoding; legacy peers use one outstanding exchange per document per connection, with conservative completion and no success inferred from an unrelated UPDATE. If completeness cannot be established, report pending/unavailable rather than clear a merge. Empty local documents and confirmed remote empty responses have explicit availability.

Drive retries by content identity, generation, eligible source, and per-transfer progress, not counts. Retry late announcements and transient failures with capped backoff. Revalidate completeness plus file revisions immediately before dedupe deletion. Status and manual sync consume the same operation state, and save failures remain separately visible.

Alternative rejected: a fixed delay before dedupe, compile, or export. Network latency and persistence delays are unbounded relative to such timers.

### D3. Shared immutable acquisition for consumers (F06, F14, F17)

After readiness, synchronously capture loaded text, file identities/paths, binary hashes, selected main file, engine, and a local change revision. Fetch assets by the captured hashes; concurrent editing can continue. Compute the compile identity from the captured bytes and settings only. Late edits mark the result stale and queue a later build, rather than changing the identity attached to the old build.

Export and backup require complete acquisition and abort explicitly on missing required content. Do not pass an incomplete map to `pushBackup`; omission is reserved for actual deletions. Preserve existing remote content on acquisition failure. Backup acknowledges only the captured revision and retains later dirty events/contributors. Tag the immutable input with its revision before asynchronous upload begins.

Alternative rejected: preserving arbitrary remote files whenever fetching fails. That can mask stale backups and makes intentional deletions ambiguous; a failed complete backup with the previous successful backup intact is clearer.

### D4. Verified epoch and current authorization (F05, F18)

Only verified same-project tickets or equivalent signed control-plane evidence advance enforced epochs. Legacy numeric epoch announcements are hints at most, with bounded refresh and no policy advance absent evidence. Propagate verified evidence instead of trusting a peer's counter. Apply the same verifier to local fresh tickets and retain per-device epoch/issued-at watermarks across connection replacement during the receiving session.

Before applying delayed content, recheck connection generation, openness, and current role; ordered frame decoding alone is not enough. Validate allowed APP topics at their privilege boundary. Keep viewers unable to originate document changes or launder them through relays.

Alternative rejected: accepting only a small numeric epoch increment. A malicious member could still increment it repeatedly.

### D5. Leased discovery and refreshable connection configuration (F07-F10)

Separate local identity loading, registration, trusted-key acquisition, and ticket refresh. Preserve existing keys when only `/keys` fails. Retry online bootstrap with one in-flight request; replace temporary offline context safely without rebuilding or discarding the project's documents. Check session generation after every await; local mode remains network-disabled.

Give signaling presence a per-device lease tied to its session ID, renew it with a heartbeat comfortably below the 90-second TTL (initial choice: 30 seconds), and expire individual entries. Renew/remove must compare the session ID so a delayed older heartbeat cannot reclaim a new session. Ready snapshots should include session IDs in an additive field while preserving legacy ticket lists. Ignore events from obsolete sockets, including their timer cleanup.

Preserve `/turn` expiry in a cache that refreshes before use, shares concurrent acquisition, and never caches failure permanently. Bound acquisition time separately from RTC negotiation. Respect rate limits with backoff/jitter and avoid refreshing per peer unnecessarily. Reserve a per-device attempt slot before the first await, keep it through authentication, and generation-check all continuations. Stop cancels owned timers, subscriptions, setup, and sockets. Repeated pause/resume must not retain manager handlers.

Alternative rejected: periodically recreating the entire session. It discards useful state and turns transient outages into UI disruption.

### D6. Bounded transport with explicit failure (F11-F12)

Add a fragment state machine, assembled-byte limit, incomplete-message deadline, and raw-frame checks before decompression. Use existing protocol limits as the baseline: document updates 32 MiB, decoded frames 64 MiB, blobs 50 MiB, and chunks 16,320 bytes; include framing overhead explicitly and reject malformed boundaries. Bound application queues in addition to the RTC buffer. The final per-peer queue budget should be measured against supported large transfers; tests use injected small budgets.

Validate chunk length, total retained bytes, source eligibility, indices, and request ranges before copying/serving. Failed or inconsistent sources reset transfer metadata so a later honest source is not pinned to an earlier wrong count. Close/error/abort settles all drain waiters and queued sends. Native IPC failure must close or signal the failed connection rather than silently swallowing delivery loss. Serialization starts before asynchronous frame encoding when message ordering matters.

Alternative rejected: relying on the final SHA-256 check or decompression limit. Both occur after memory has already been retained elsewhere.

### D7. Stable folder baselines and editor generations (F15-F16)

Initialize mirror baselines on verified equality as well as successful writes. Advance them only after disk success; retry failed writes without treating a pre-written hash as proof of success. Reconcile from available content, retain overlap as an explicit conflict, and enforce role checks before initial imports and after asynchronous waits. Preserve existing safe-path and user-selected-folder boundaries.

Give editor mount/rebind a monotonically increasing generation tied to the session and file. Check it after every load; a stale mount disposes its own resources and cannot install a view. Destroy previous undo managers and invalidate pending loads on component teardown. Carry this lifecycle convention to ticket refresh, snapshots, and session-owned compile callbacks/timers.

Alternative rejected: disabling file switching during loads. It impairs normal editing and does not address teardown races.

### D8. Tests that model failure, not only fast convergence

Build reusable deferred persistence/transport helpers and an expiry-aware signaling backend. Cover each finding with a focused regression before the corresponding fix. Preserve existing happy-path suites. Add deterministic schedules for delayed STEP2, partial root/file arrival, storage failure, restart at journal boundaries, identity recovery, credential expiry, and close-during-send. Assert exact surviving content and settled resources, not merely eventual identical text (identical text can mean both devices lost the same edit).

Run real-browser scenarios for reconnect, editor switching, and late content; retain the existing seven-user DOM latency test and 12-peer mesh tests. Add simultaneous binary transfer plus editing. Run the native RTC adapter fault cases without requiring an actual production TURN service. Use a disposable local relay environment for controlled relay-only validation; real internet-path results must be reported separately.

## Risks / Trade-offs

- [Legacy peers lack correlated receipts] -> Preserve wire compatibility and expose conservative pending state; do not manufacture merge success. Test old/new combinations explicitly.
- [Crash journal migration or rollback can resurrect/duplicate work] -> Additive versioning, idempotent operation IDs, fixtures for each transition, and retained legacy recovery records until migration commits.
- [Stricter completeness can delay export/backup/compile] -> Show missing inputs and permit continued editing or exporting a complete local recovery copy; never silently substitute content.
- [Presence heartbeats and TURN refresh increase control-plane calls] -> Lease only signaling participants, share credential acquisition, back off on rate limits, and measure call volume.
- [Retry queues and journals retain more memory/storage] -> Merge retained updates, bound transport queues, expose storage failures, and never delete the only recovery copy to meet a budget.
- [The main spec already has contradictory viewer bootstrap/retention statements] -> Preserve current write authorization and explicit demotion behavior; record those separate product decisions rather than quietly broadening this change.
- [Healthy localhost tests do not prove hostile-network performance] -> Keep reproducible CI thresholds and report relay-only/device measurements with topology and hardware.

## Migration Plan

1. Land regressions and independent guards first: failed-write recovery, authoritative epochs, complete backup acquisition, and transport cancellation/bounds.
2. Introduce the additive versioned journal and lifecycle generations, including restart fixtures and old-record recovery. Do not erase unknown recovery metadata.
3. Add availability/reconciliation APIs and negotiated receipts, then migrate merge, dedupe, status, mirror, export, compile, and backup consumers.
4. Roll out discovery/credential/session recovery and editor lifecycle changes. Update protocol, offline, performance, permissions, and security documentation to reflect measured behavior and remaining limitations.
5. Validate mixed clients and all regression gates before deployment. Implementation may be split into reviewable commits, but the change remains incomplete until every task is satisfied. Any eventual triggering push must be monitored through terminal CI status under repository policy.

Rollback must retain both legacy metadata and the new journal while a recovery operation is pending. Do not reopen a pending versioned recovery record in an older client that cannot interpret it; export/recover it with a compatible build first. Server presence changes should support old ready-message consumers during rollout. No server document-content storage or project CRDT migration is required.

## Open Questions

- Measure the final per-peer queued-byte budget and fragment assembly deadline against the existing large-transfer benchmark and native adapter; the bounded-memory and cancellation requirements are fixed.
- Select available machines for relay-only and mixed desktop/browser validation during implementation. Record unavailable platforms explicitly rather than treating mock parity as an end-user test.
