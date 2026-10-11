# Tasks

All tasks below are implementation work for a later apply request. The completed audit and baseline evidence are in `design.md`; unchecked boxes do not mean the audit remains to be performed. Finding IDs refer to that design. Each group includes its own regressions and documentation; group 9 checks integration only.

## 1. Local durability and recovery foundations

- [x] 1.1 Add deferred/failing persistence helpers in sync tests and reproduce F01 with failed append and compaction; verify the tests distinguish retained edits from an apparently successful but incomplete flush.
- [x] 1.2 Make `DocPersister` retain failed batches, recover its write chain, and retry with bounded backoff; verify both pre-failure and post-failure edits survive reopening and retries do not duplicate text.
- [x] 1.3 Serialize document replacement with outstanding writes and add atomic update/metadata transitions to memory and IndexedDB persistence; verify delayed append/compaction cannot overwrite a newer replacement.
- [x] 1.4 Define and migrate the versioned recovery journal with operation IDs and explicit stages; verify existing v1 fork/conflict fixtures remain recoverable and migration failure leaves the old recovery records intact.
- [x] 1.5 Expose local save failures and recovery export in the workspace, and document recovery behavior in `docs/offline.md`; verify a persistent warning during injected storage failure, successful export of retained work, and clearing only after committed recovery.

## 2. Transport cancellation and input bounds

- [x] 2.1 Fix drain waiters and queued sends to reject on close/error/abort in `transport.ts`; verify F11 with close above the high-water mark and assert every pending promise settles without a drain event.
- [x] 2.2 Add bounded fragment assembly, sequence checks, raw-frame limits, queue accounting, and assembly timeout; verify F12 using injected small budgets and ensure malformed traffic does not interrupt a healthy peer's edits.
- [x] 2.3 Validate blob chunk length, cumulative bytes, source eligibility, indices, and finite request ranges; verify oversized chunks are rejected before retention and an honest source succeeds after a bad source advertises inconsistent totals.
- [x] 2.4 Propagate native RTC IPC send failures and cancellation through connection ownership; verify `tauri-rtc.test.ts` covers pending IPC failure/close and that no send is silently reported as delivered.
- [x] 2.5 Serialize order-sensitive outbound encoding and document transport budgets in `docs/protocol.md`; verify mixed compressed/uncompressed control frames retain the required order and the existing 20 MiB transfer test remains within the chosen queue budget.

## 3. Epoch authority and delayed authorization

- [x] 3.1 Accept enforced epoch advances only from verified same-project authority, including the local ticket refresh path; verify F05 with forged numeric epochs from viewers, wrong-project/expired evidence, and valid refreshed tickets.
- [x] 3.2 Retain per-device ticket freshness across connection replacement and recheck generation/role before delayed document application; verify F18 with demotion during a deferred load and reconnect using an older editor ticket.
- [x] 3.3 Validate privileged application messages at their handler boundary and update `docs/protocol.md` and `docs/security.md`; verify existing tampered-viewer tests still pass and unsupported epoch hints neither evict peers nor cause repeated refresh storms.

## 4. Discovery and session lifecycle

- [x] 4.1 Reserve connection attempts before asynchronous configuration and own all setup/retry callbacks through generations; verify F10 with duplicate discovery, deferred ICE, stop-before-resolution, authentication failure, and repeated pause/resume without leaked handlers or transports.
- [x] 4.2 Implement session-scoped per-device signaling leases and heartbeat renewal, including compare-and-renew and additive ready-session IDs; verify F08 using an expiry-aware backend for idle late joins in both device-ID orderings and old-session heartbeat/cleanup races.
- [x] 4.3 Preserve TURN expiry, share refresh requests, bound acquisition time, and make initial failure retryable; verify F09 with an advanced fake clock, failed first fetch, hanging fetch, concurrent peer attempts, and rate-limit backoff.
- [x] 4.4 Separate local identity, registration, trusted-key, and ticket recovery in `ProjectSession`; verify F07 by opening a cached shared project offline, restoring connectivity, and observing automatic peer synchronization without a reload or false revocation.
- [x] 4.5 Cancel session-owned ticket refreshes, timers, subscriptions, and pending callbacks on close or pause; verify late API/RTC responses do not recreate closed work and explicit local mode makes no server request.
- [x] 4.6 Document heartbeat, TURN renewal, offline-start recovery, and lifecycle diagnostics in `docs/protocol.md` and `docs/offline.md`; verify descriptions match the new tests and contain no project content in server diagnostics.

## 5. Explicit availability and synchronization completion

- [ ] 5.1 Introduce persisted local completeness and per-connection reconciliation state distinct from loaded/stored document existence; verify unknown, partial, locally created empty, remotely confirmed empty, and reopened complete documents are classified correctly.
- [ ] 5.2 Add awaitable, cancellable document reconciliation with current-round receipts and negotiated capability support; verify delayed/old replies and unrelated incremental updates cannot complete a new round, and legacy STEP1/STEP2 peers retain conservative interoperability.
- [ ] 5.3 Drive missing-content retries by document/blob identity, source, and generation with per-transfer stall clocks; verify F13 for late blob availability, same-count peer/asset replacement, and an active file that cannot hide another file's stall.
- [ ] 5.4 Make `SyncTracker`, manual sync, and workspace messages use current reconciliation outcomes; verify cached reconnects and queued-but-unanswered requests do not claim success or advance the successful sync time.
- [ ] 5.5 Gate duplicate consolidation on completeness and final revision revalidation; verify F04 with delayed differing bodies at one path, an edit during equality checks, and genuinely identical complete files still consolidating safely.
- [ ] 5.6 Document availability, saving, current synchronization, and legacy limitations in `docs/offline.md` and the sync API documentation; verify the terminology matches the status UI and complete-state consumer contract.

## 6. Crash-safe offline merge execution

- [ ] 6.1 Persist base/mine/journal atomically before document replacement and commit results/conflicts before clearing recovery state; verify F02 by restarting from each journal transition with exact content preserved once.
- [ ] 6.2 Require current-round remote confirmation and fail closed on preparation error, timeout, or disconnect; verify F03 with slow root/file responses, failed checkpoint writes, late replies, and eventual reconnect/conflict resolution without premature sharing.
- [ ] 6.3 Protect edits typed during capture, replacement, and conflict resolution, and retain the existing explicit demotion policy; verify concurrent typing and restart tests plus a demoted member never publishing unauthorized changes.
- [ ] 6.4 Document recovery stages, interrupted-merge behavior, version compatibility, and rollback restrictions in `docs/offline.md`; verify migration/restart fixtures demonstrate every documented recovery path without deleting unknown journals.

## 7. Editor and folder correctness

- [ ] 7.1 Add generation-checked editor mounting/rebinding and complete undo/view disposal; verify F16 with reverse-order file loads, replacement while loading, close while loading, and repeated switches that leave exactly one correctly bound editor.
- [ ] 7.2 Initialize mirror baselines on equal-content binding and advance them only after successful writes; verify F15 with matching initial files, concurrent remote/local edits, failed disk write followed by retry, and rename/delete during a write.
- [ ] 7.3 Make initial folder reconciliation use content readiness, enforce viewer permissions, and retain overlapping restart edits for explicit resolution; verify missing text never empties a disk file, viewer binds never mutate project content, and both conflict versions survive restart.
- [ ] 7.4 Add real-browser delayed-load and folder-reconciliation regressions and update `docs/folders.md`; verify the selected file remains the typing target and documented initial-bind behavior matches viewer/editor tests.

## 8. Complete snapshots, compilation, export, and backup

- [ ] 8.1 Add a complete immutable acquisition API capturing file revisions, text, asset hashes, main file, and engine; verify delayed asset acquisition cannot change captured text and complete local projects remain usable offline.
- [ ] 8.2 Migrate compile input identity and stale-result checking to captured inputs including settings; verify F14 with main/engine-only changes and a delayed `zzz.png` fetch after `main.tex` capture, proving result identity matches compiled bytes.
- [ ] 8.3 Migrate source export and snapshot/history consumers that require complete content; verify initial-sync export waits or reports missing files, and no complete-project artifact substitutes empty placeholders.
- [ ] 8.4 Make backup acquisition fail before remote mutation when content is missing; verify F06 with a fake GitHub remote retaining a previously backed-up image, and a separate intentional deletion still updating the manifest and tree correctly.
- [ ] 8.5 Track backup completion against its captured revision and retain later dirty edits/contributors; verify F17 with a deferred remote update followed by another edit, then a second backup containing that edit without needing further typing.
- [ ] 8.6 Update `docs/compilation.md`, `docs/github-backup.md`, and export help for complete-input outcomes; verify documented success, missing-content, settings-change, and concurrent-backup behavior against the tests in this group.

## 9. Integration and compatibility gates

- [ ] 9.1 Run sync, protocol, compile, GitHub, affected web, and signaling unit/integration suites plus relevant type/lint checks; verify all new regressions and baseline suites pass, recording exact commands and outcomes in the change. Read installed Turborepo guidance before invoking or changing repository Turbo commands.
- [ ] 9.2 Run real-browser collaboration, offline merge, sync status, and editor/folder scenarios together, including reconnect with a binary transfer in flight; verify exact text preservation, settled shutdown, correct outcomes, seven-user p95 below 250 ms on the healthy test topology, and existing 12-peer relay efficiency.
- [ ] 9.3 Validate mixed legacy/current clients, migration/restart fixtures, expiry-aware production-backend parity, native RTC adapter faults, and controlled relay-only reconnection; deliver a compatibility matrix separating executed checks from any unavailable real-device environments, with no unresolved required regression silently marked passed.
- [ ] 9.4 Run OpenSpec validation and review the final finding-to-fix/test mapping; verify every F01-F18 item has implementation evidence and the explicitly deferred multi-tab/viewer-bootstrap/native-audit boundaries remain accurately documented.
