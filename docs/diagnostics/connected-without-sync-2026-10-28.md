# Connected co-author without source synchronization: investigation

Reported environment: desktop 0.10.0, two connected co-authors. The supplied report was generated at 2026-10-28T12:18:56.941Z. The live project's share ID is omitted from this public diagnostic note. No live project sources, membership or remote application state were changed during this investigation.

## Findings established by the report and source

1. The two devices exchanged an encrypted signaling probe and reply through the service in 433 ms. This proves service-level communication at that moment; it does not prove that either WebRTC data channel was transferring application data.
2. The reported established route is TURN, with a **local host candidate and remote relay candidate**. The test accepts that existing mesh connection and returns success in 0 ms without sending a test payload through it (`ConnectionManager.probePeer`, `packages/sync/src/connect.ts`). Only an application-relay route currently gets an encrypted `net-ping` / `net-pong` round trip. Direct and TURN routes skip that check.
3. `reconnectNow()` cancels pending connection attempts, but leaves authenticated mesh connections in place. `busy()` considers these devices already connected, so it does not start a replacement. `ProjectRuntime.syncNow()` calls this method and then retries document acquisition on the existing link. Thus Sync now is not a guaranteed reconnection of a stale authenticated path.
4. The native ring log is global to the WebRTC stack (`rtc_log.rs`) and does not identify a project, peer or allocation. Its repeated TURN refresh errors cannot be attributed conclusively to this active route. Because the selected local candidate is host, a failed local relay allocation might belong to an unused candidate or another connection.
5. TURN Refresh error 437 means the refreshed allocation no longer exists ([RFC 8656, section 8.3](https://www.rfc-editor.org/rfc/rfc8656.html#section-8.3)). Repeating that failed refresh does not restore the allocation. The log alone does not establish which active path is affected or the cause of the accompanying permission error 400.
6. The mesh already sends heartbeats and closes a connection after 20 seconds without received frames. `lastRx` records incoming frames, not outgoing sends. Therefore a persistent hours-long blackhole of *all* incoming application traffic should trigger this mechanism; the field evidence also permits a problem limited to one channel, replica application, source completeness, or unused TURN resources. A full data-path blackhole is a reproduction of the diagnostic weakness, not a proven root cause of the user's project.

## Reproduction

An isolated test uses two authenticated fake WebRTC peers and the real connection manager, mesh and signaling probe. After both peers authenticate, both transports accept but silently discard every application frame. The signaling service remains available.

Observed on 0.10.0 code:

- The signaling probe still receives its answer.
- `probePeer()` reports `connected` and a successful verdict despite the deliberately unusable application path.
- `reconnectNow()` retains exactly the same authenticated connection object.

Command: `pnpm exec vitest run test-results/sync-investigation/connected-without-data.test.ts`.
Result: one passing diagnostic reproduction. The temporary test lives under ignored test-results; this is not a new normative test asserting that the defective behavior should be retained.

## Next verification and correction targets

- Obtain both devices' Sync-panel state, whether failure is directional, pending/missing file counts, last confirmed synchronization, any offline-merge conflict/error and quarantined operation/history status. The supplied network report contains none of these replica-layer outcomes.
- Require a correlated application round trip on the selected data route, including TURN/direct, before reporting a successful connection test. A signaling reply or cached ICE state must not satisfy that assertion. A sync-channel echo alone must not claim that asset delivery or source reconciliation has completed.
- On an explicit reconnect or a failed route probe, retire the stale authenticated connection, reacquire signaling/credentials as needed and verify a new connection or encrypted application-relay route, with source edits retained locally.
- Diagnose document reconciliation and safety/history admission separately if the data-route echo succeeds. A healthy socket does not imply sources were applied or durably stored.

These targets are separate from the completed `import-zip-and-build-local-projects` change. No TURN server configuration, remote source content or synchronization implementation was modified for this investigation. The exact cause of the reported live project's synchronization failure remains unconfirmed pending replica-layer state or a live reproduction.
