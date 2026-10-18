# Project runtime and registry (developer notes)

Synchronization of a project is owned by one **project runtime** (`packages/sync/src/runtime.ts`), independent of the
UI. The web app's `ProjectSession` (`apps/web/src/lib/session.svelte.ts`) is a thin reactive view plus the foreground
services; the desktop's bundled Node worker hosts the authoritative runtimes without a DOM.

## What the runtime owns

The supervisor/worker pipe retains an 8 MiB per-frame limit. A larger logical storage message is split into ordered
frames using the high header bits (`MORE=0x80000000`, `CONTINUATION=0x40000000`, low 30 bits = payload length).
Only a complete, correctly ordered message is decoded and dispatched. Logical messages are capped at 160 MiB;
malformed sequences, truncated frames and excessive assembly sizes fail conservatively. Normal native input queues
remain bounded at 64 MiB; one larger message may occupy an otherwise empty queue. A closed generation releases pending
assemblies. These flags concern the local inherited pipe, not the peer wire protocol.

Large persistence batches commit each operation and its preimage/update record atomically, in order, rather than
combining arbitrarily many full preimages into one IPC request. If a suffix fails, the committed prefix survives and
only the remaining operations retry. The save acknowledgement waits for the whole requested flush.

Each operation record stores an inverse delta (removed text with its position, previous root values, replaced blob
hashes), not the whole document. A full snapshot is kept only when a Changes group opens and when one edit removes more
than half of a document, once per distinct content. Signed envelopes carry no preimage; each receiver computes its own.
`packages/sync/test/provenance-growth.test.ts` holds the bound: 1,000 keystrokes in a 100 KB file with one co-author
must add less than 3 KiB per keystroke plus 8 document copies to each store, and send less than 3 KiB per keystroke.
The first measurement was about 1.7 MB added per store and 0.9 MB sent, in three groups. The same typing in a
document four times larger must cost the same on the wire, within 25%.

Hot paths never list the whole metadata store. `listMetaKeys(prefix)` is a key range in every adapter (memory,
IndexedDB `IDBKeyRange`, SQLite primary-key range in pages); Recovery reads `recovery:record:` only, projected Changes
read `operation:projected:`, and `knownDocIds` comes from document keys. `RecoverySection` refreshes on the store's
"recovery changed" event, not on every document update. `history-scale.test.ts` applies co-author edits over 500,000
retained records and counts full listings (none allowed).

| Part | Responsibility |
| --- | --- |
| `ProjectModel`, `ChangeLog` | the replica and its local history, on an injected `Persistence` |
| `OfflineFork` | unshared work, offline merge checkpoints and conflicts |
| `Mesh`, `BlobManager`, `SyncTracker` | authenticated peers, document and blob exchange, progress and honest sync status |
| identity and tickets | device registration, trusted keys, the ticket loop (offline retries, revocation, dormancy) |
| `ConnectionManager` | signaling, WebRTC, the application relay and doorbell introductions |
| `Doorbell` | the project's ring topic on the push service |

It does **not** start a compiler, push GitHub backups or bind folders. Those are
foreground services that attach to `runtime.model`, `runtime.mesh` and `runtime.blobs` while an editor is open
(`runtime.test.ts` checks that the runtime's module graph reaches none of them).

## Adapters

Everything environment-specific comes in through `ProjectRuntimeOptions`:

| Adapter | Browser | Desktop worker |
| --- | --- | --- |
| `store` | `IndexedDbPersistence` | native SQLite (group 5) |
| `keys`, `deviceId`, `registerDevice` | `localKeys` / `registerKeys` (IndexedDB or keychain) | OS keychain through the supervisor |
| `loadTrusted`, `fetchTicket`, `ring`, `iceServers` | `api()` over `fetch` | the same HTTP calls from the worker |
| `signalUrl`, `wsFactory` | `WebSocket` | WebSocket in the worker |
| `rtcFactory` | `RTCPeerConnection`, or the Rust bridge where the webview has none | native RTC through the worker bridge, on the shared muxed UDP listener |
| `pushChannel` | ntfy over `fetch` streaming | the same |
| `createManager` | `new ConnectionManager` (tests inject fakes) | the same |
| `events` | copied into Svelte `$state` fields; toasts | status for tray and dashboard |

A runtime emits `events.change` whenever an observable field changes (`offline`, `revoked`, `role`, `peers`,
`connecting`, `syncStatus`, `doorbellState`, `unsharedWork`, `conflicts`, `saveFailing`); views copy what they show.

## Lifecycle

```
open()            -> replica, fork, mesh, tracker ready; no network yet
startNetworking() -> ticket loop -> connection manager (doorbell mode once the push service is subscribed)
setPaused(true)   -> no requests, no sockets, no push subscription; edits kept; setPaused(false) recovers
close()           -> networking and timers stopped, mesh destroyed (the owner then destroys the model and store)
```

## Registry: one runtime per server, account and project

`RuntimeRegistry` (`packages/sync/src/registry.ts`) hands out **leases** of kind `editor` or `background` for a key
`(server, account, project)` (the server origin is canonicalised).

- Concurrent attachments share one initialization; the runtime runs while at least one lease exists.
- **Detach** (`lease.release()`): drops one lease. Closing a workspace releases the editor lease; a background lease
  keeps the runtime running, so the seed continues and only foreground services stop.
- **Stop** (`registry.stop(key)`): ends the runtime whatever its leases (removal from the project, deletion).
  An initialization still in flight is cancelled: its late result is closed and its leases reject with
  `RuntimeCancelled`.
- **Stop barrier** (`registry.stopWhere(filter)`): sign-out, account or server switch, local mode. Resolves only when
  every matching runtime is closed; nothing of the old account can be attached afterwards.
- A lease of an older generation never stops a newer attachment of the same key, and a new attachment waits until the
  previous runtime of that key is fully closed (one writer per store).
- `setPaused(key, true)` is remembered for a runtime that is still starting.

`registry.test.ts` exercises each of these transitions.

## Desktop editor attachment

The native `seed-catalog.sqlite3` stores retained selection and pause preferences, scoped to the active server/account.
Only projects opened or explicitly downloaded are retained. Native startup restores their dormant ring subscriptions
without creating a project actor. A verified ring creates a background lease in the same registry as the editor.
`SharedPushChannels` multiplexes all foreground and dormant subscriptions for a service onto one physical stream.

Account changes first freeze networking and reject new attachments, then let accepted local input reach durability,
then close every project and clear the active profile. The new account activates only after this barrier. Native RTC
events and delayed creation results are bound to both worker generation and project store ownership; a late allocation
is closed rather than exposed to the next project owner. A worker exit closes its native stores/RTC even if restart
backoff ends in needs-attention. When a new generation reports ready, an open editor attaches again under the same
attachment id: the new worker replays the edits the old one had journaled (once, keyed on attachment and sequence), the
editor brings its loaded documents up to the worker's state and resends the edits not yet durable; the save warning
clears once they are. Demotion disables seed eligibility and every awaited mutation checks current edit rights.

Native route/gateway observation uses pinned `netdev 0.38.2` (MIT; [source](https://github.com/shellrow/netdev/tree/v0.38.2)).
Its local OS snapshot is sampled every five seconds, with no probe payload or control-plane call. A delayed sample
signals resume; route/gateway/address changes advance network generation. Healthy resume replaces push streams and
recovers previously awake/offline demand. Dormant projects do not fetch tickets on resume. Explicit global/project
Work offline survives catalog restart and still blocks recovery. The desktop zero-idle policy never substitutes an
idle gatekeeper socket for a failed push channel; explicit Sync now retains a bounded introduction window.

`WorkerProjects` owns the native SQLite store, mesh and edit journal. `WorkerRenderer` exposes a transient editor
replica and service facades; it does not open a second SQLite writer or a second network mesh. Attaching exchanges
state vectors and a revision barrier; deltas received during the snapshot are applied after the barrier. Edits are
journaled by native code before pipe delivery and acknowledged as saved only after the actor commits them. A worker
crash replays journaled edits. Refused edits stay in the recovery journal and cannot be replayed after a role promotion.
File commands, undo, import and snapshot restore use actor authorization. Conflict resolution includes the revision
the editor saw; stale decisions are rejected.

Local compilation, GitHub backup and folder watchers belong to the editor attachment. Closing the editor
cancels their listeners, timers and in-flight work before releasing its lease. An available background actor does not
compile, back up or watch folders. External folder edits made while closed are reconciled by the existing three-way
merge on the next open; they are not published by a seed. Cancelling a folder open invalidates its pending native
binding so a late result cannot replace a newer binding.

On last-editor detach the actor replaces its local awareness with `{seed: true, deviceId}`: no user, cursor or open
file remains. Reopening restores foreground awareness. The People panel labels an updated peer as **background seed**;
the optional awareness fields are advisory and do not grant membership or edit rights. Older peers can ignore them.
An absent seed field keeps the ordinary presence presentation.

## Seed statuses and their tests

`SeedCatalog.list()` reports one stage per retained project. The README describes them for users; each is asserted:

| Stage | Test |
| --- | --- |
| `dormant` | `seed-catalog.test.ts` › restores dormant projects |
| `connecting` (push stream still opening; not an outage) | `seed-catalog.test.ts` › reports every documented seed status (polls past it) |
| `queued` (more than four awake) and rotation | `seed-catalog.test.ts` › keeps at most four background projects awake |
| `disabled`, `paused`, `offline`, `ring-channel-unreachable`, viewer refusal | `seed-catalog.test.ts` › reports every documented seed status |
| `auth-required` | `seed-catalog.test.ts` › locked credentials |
| tracker stages up to `synced`; missing asset stays `receiving` | `seed-hydration.test.ts` |
| file `deferred` (`storage-budget`, `storage-full`) | `transfer-budget.test.ts` |
| peers disconnected at ticket expiry without refresh | `mesh.test.ts` › disconnects peers whose ticket expired |
| ring rate limit (1 / 20 s per device and project) | `server/test/doorbell.test.ts` |

## Native transport (desktop worker)

The worker's peer connections use the Rust WebRTC stack (`src-tauri/src/rtc.rs`) through the worker bridge; the
application relay stays the shared TypeScript adapter on both platforms. All native connections of one network
generation share one IPv4 UDP listener (`src-tauri/src/transport.rs`): reference counted, closed with its last
connection, replaced for new connections when the network monitor advances the generation. Gathering keeps host,
STUN, TURN and IPv6 host candidates; a verified router mapping of the listener is added as a server-reflexive
candidate backed by the same socket, through the pinned `webrtc-ice` patch (`src-tauri/vendor/PATCHES.md`). A
withdrawn or changed mapping is excluded from the next negotiation at once; an existing connection keeps its pair
until ICE consent fails, then reconnects with current candidates. `rtc_stats` exposes the selected pair as standard
statistics (types for route display; addresses stay on the device).

Focused evidence: `editor-commands.test.ts`, `worker-runtime.test.ts`, `worker-presence.test.ts`, `mirror.test.ts`, and
the compile/backup cancellation suites. See the change's `verification.md` for desktop acceptance coverage.
