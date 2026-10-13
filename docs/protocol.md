# Wire protocol and sync model

## Transport

Each pair of devices talks over WebRTC with two reliable, ordered data channels:

* `sync` – handshake, CRDT updates, awareness, control and compile messages;
* `bulk` – binary blobs (images, PDFs).

Messages larger than 16 KiB are fragmented (1 byte header: single / first / middle / last) and sends honor
`bufferedAmount` back-pressure (1 MiB high-water mark). Signaling messages (SDP/ICE) are end-to-end encrypted between the
two devices (X25519 → HKDF → AES-256-GCM) before they touch the relay.

### Transport budgets

Every limit below is enforced before the data is decompressed, copied or retained, and each connection is bounded on its
own, so a misbehaving peer is dropped without affecting the others.

| Budget | Value | On violation |
| --- | --- | --- |
| One raw fragment | 16 KiB + 1 header byte | peer connection closed |
| Fragment sequence | single, or first, middle\*, last; no empty frames, no unknown kinds | peer connection closed |
| Reassembled message (per channel) | 64 MiB + 1 KiB framing (the decoded-frame limit) | peer connection closed |
| Incomplete message | 30 s without a further fragment | peer connection closed |
| Outbound queue (per channel) | 128 MiB + 2 KiB (two maximum messages) | that `send` rejects |
| Received but not yet decoded (per connection) | the same 128 MiB + 2 KiB | peer connection closed |
| Decompressed frame | 64 MiB | peer connection closed |
| Document update / blob | 32 MiB / 50 MiB | rejected |
| Blob chunk | 16,320 bytes; every chunk but the last is full-size | chunk rejected, source ignored for that fetch |

Closing, erroring or aborting a channel rejects the send that is waiting for the buffer to drain and every send queued
behind it; nothing waits for a drain event that a dead channel never delivers. With the native (Rust) WebRTC bridge, a
failed IPC send closes the channel and the connection that owns it, and nothing queued after the failed message is sent.

Outbound frames are encoded concurrently but handed to the transport in call order on each channel, so a compressed
frame is never overtaken by a small uncompressed one sent after it.

## Discovery and session lifecycle

**Signaling messages** (JSON over the `/api/signal` WebSocket): the relay sends `challenge`; the client answers `auth`
(ticket + signature of the challenge with its device key); then `ready` (the devices present), `join`, `leave`, `sig`
(an encrypted envelope for one device) and `pong`; the client sends `sig` and `ping`. `ready` carries `tickets` (one
per other device, as before) and, additively, `sessions` (device id → session id of that entry). Older clients ignore
the field, and older relays omit it.

**Presence is a lease.** Each device's entry (`<session id>|<ticket>`) expires 90 s after it was last written, on its
own: another device's heartbeat never keeps it alive. An open, authenticated socket sends `ping` every 30 s (`heartbeatMs`),
which renews the lease only if the entry still belongs to the session that sent it (compare-and-renew). A session whose
lease already ran out (a throttled background tab) announces itself again, but only when no entry exists; a late
heartbeat or close of an older session of the same device never renews, replaces or removes the entry of the newer one,
and a `leave` is announced only when an entry was actually removed. A client ignores the `leave` of a session other than the
latest it saw (from `join` or `ready.sessions`). So an idle member stays discoverable for a late joiner whichever of the
two device ids is lower. Redis keeps the expiry inside each hash field (`<expiry ms>;<value>`) because it can only expire a
whole hash; `getPresence` hides and prunes expired fields.

**Relay credentials.** `POST /turn` returns `iceServers` and `expiresAt` (one hour). The connection manager keeps the
answer until 60 s before that time (10 minutes if no expiry is given), then asks again before the next attempt uses it.
Attempts that start while a request is in flight share it, the wait is bounded (`iceTimeoutMs`, 5 s) and is separate from the
20 s link deadline, and a failure is never kept: the attempt goes ahead with the STUN servers it already knew, and the next
one asks again after a backoff of 1 s doubling to 60 s with jitter (at least 30 s after a 429, or the `Retry-After` the
server sent).

**One attempt per device.** The slot for a device is reserved before the attempt awaits its configuration and is held
through the peer handshake, so duplicate announcements (relay join, peer exchange) share it. Every continuation (awaited
configuration, sealing, socket and RTC callbacks, retry timers) checks the manager's generation: `stop()` cancels all
timers, closes the socket and links, removes the manager's mesh handlers and invalidates what is pending, so pausing and
resuming repeatedly never leaves handlers, transports or timers behind. Messages of a socket that is no longer the current
one are ignored.

## The doorbell: waking devices without a server connection

No device keeps a connection to the server while it waits (D14). Instead every running client keeps **one
subscription to a push service** (ntfy, `https://ntfy.sh` unless the server says otherwise) for the ring topics of its
projects, and the server holds a signaling socket only while devices are being introduced.

1. **Topic.** The ticket answer carries `doorbell: { url, topic }`. The topic is an HMAC of project id and membership
   epoch under a key derived from the ticket signing key: opaque, the same for all members, and different after any
   epoch change (removal, demotion), so a removed member no longer knows it.
2. **Ringing.** A client that needs co-authors (it opens a project and nobody is connected, or Sync now) calls
   `POST /projects/:id/ring` with its device id. After the membership check the server returns a token: an Ed25519 JWS
   (`typ: hivetex-ring`, signed with the ticket key) with only `v`, `topic`, `ep`, `iat`, `exp` (60 s) and a random
   nonce `n`. The client publishes it to the topic itself (`POST <url>/<topic>`, `Cache: no`). One message rings every
   device of the project. Limits: one ring per device and project per 20 s, 60 an hour.
3. **Waking.** Subscribers verify the token offline (pinned ticket keys, exact topic, epoch not older than their own,
   unexpired, nonce not seen, not their own ring) and drop anything else without any network activity. A device that is
   not linked to anyone answers, and so does the lowest device id of an existing mesh; the others are introduced
   through peer exchange. A device answers at most one ring per project every 10 s (120 an hour).
4. **Introduction window.** Ringing or answering opens the signaling socket (fetching a fresh ticket first if the old
   one lapsed). The socket closes once every device seen there is linked (after at least 8 s, so late answers still find
   us) or after 30 s. Devices that are connected keep editing peer to peer and renew tickets; a device that is alone and
   has no socket renews nothing.
5. **Fallback.** Without the push service (unreachable, or `DOORBELL_URL=off`), a client keeps the older behaviour: a
   gatekeeper socket while the project is open, so it stays reachable while open. Older clients still keep gatekeeper
   sockets; current clients find them when they introduce themselves.

Pausing (Work offline) also closes the push subscription. Tests: `server/test/doorbell.test.ts` (topics, tokens, limits,
dev push service), `packages/sync/test/doorbell.test.ts` (verification, replay, epochs, wake budget, ntfy stream),
`server/test/doorbell-e2e.test.ts` (introductions with the real hub, representatives, older clients, fallback).

## Route selection and the application relay

A connected peer is reached in one of three ways, shown per person in the People panel (`ConnectionManager.routes()`):

| Route | When | What the server sees |
| --- | --- | --- |
| **Direct** WebRTC | ICE found a host or server-reflexive pair (the normal case, also on most home networks) | nothing after signaling |
| **TURN** WebRTC | the deployment configured TURN (`CF_TURN_*`) and only a relayed candidate pair works | nothing: TURN carries DTLS ciphertext |
| **Application relay** | neither works, and the server and both clients negotiated `application-relay-v1` | routing metadata and ciphertext frames |

Preference is always direct, then TURN, then the application relay. When a relay-capable peer has no working link 8 s
after it was seen (`relayAfterMs`), or a WebRTC attempt failed, the lower device id starts relay setup (the spec requires
it within 10 s). With TURN credentials configured the relay waits until that WebRTC attempt failed or timed out: TURN
costs the control plane nothing per byte, a relay session holds sockets open. While a peer is reached through the relay, direct
attempts continue every 60 s at most (`directRetryMs`). When a direct link authenticates, the mesh replaces the relay
connection (both ends must have completed the key-possession handshake on the new path first) and the Yjs exchange on
the new connection fills any gap; the old relay generation is then closed.

**Negotiation.** The client adds `capabilities: ["application-relay-v1"]` to `auth`. A server that has the relay role
enabled answers with a relay session id (`r1_…`) and the capability in `ready`, and announces it in `join`. A client uses
the relay towards a device only if its own and the device's session ids are relay sessions. Older servers ignore the field
and older clients never send it: they keep using WebRTC only.

**Relay messages.** `{ t: 'app-relay', to, sid, env }`: `to`/`sid` name the recipient's current session; the server adds
`from`/`fromSid` from the sender's authenticated socket and publishes to that one session's channel. `env` is either a
handshake step (`H…`) or an encrypted frame (`F…`, at most 16 KiB of plaintext). The handshake binds fresh ephemeral keys
to both tickets ([application-relay-security.md](application-relay-security.md)); its transcript hash then replaces the
DTLS fingerprints in the usual peer authentication, so a relay connection proves device-key possession like a WebRTC one.

**Delivery** (`packages/sync/src/relay-transport.ts`). Redis Pub/Sub delivers at most once, so a published frame counts
for nothing: each data frame is acknowledged by the peer (authenticated, batched within 20 ms), at most 256 KiB stay
unacknowledged per peer, a missing ACK triggers a retransmission of the identical ciphertext (1.5 s, doubling, six
times), and then the connection closes and reconnects with new keys. The receiver reorders per channel and applies every
frame once. An ACK only releases sending credit; it is not a save receipt and not reconciliation: the Sync panel's states
and "All changes synced" still come from the peers' answers for each document and from stored blobs.

**Socket lifetime.** Relay sessions belong to one signaling socket. When Vercel ends the socket (300 s) or an instance
goes away, both clients reconnect, run a new handshake and the mesh reconciles; nothing of the old encrypted session is
replayed. Edits made meanwhile stay on the device.

**Limited relay.** If the server refuses forwarding (`relay_limited`: the deployment budget is spent;
`relay_accounting_unavailable`: the budget store cannot be reached; rate limits), the peer shows *server relay limit
reached: changes wait on this device*. Text and control frames go first; files (`bulk`) wait until the retry time the
server gave. Nothing is dropped and direct links are not affected. See [deployment.md](deployment.md#application-relay)
for the budgets.

**No source online.** The relay only connects devices that are online. When no owner or editor device holding the
project is reachable, a new member gets the usual *no co-author online* state (and the GitHub bootstrap, if linked);
there is no server copy to fall back to.

Tests: `packages/sync/test/relay-transport.test.ts` (loss, duplicates, reordering, stalls, credit, priority),
`server/test/application-relay-e2e.test.ts` (current clients and the real hub with WebRTC unusable: setup deadline,
text and images, socket rotation, subscription failure, handover, limited budget, incomplete-image status, older peers),
`e2e/application-relay.spec.ts` (two browsers, `APPLICATION_RELAY=1`) and the desktop e2e relay test.

**Diagnostics** (`ConnectionManager.candidates()` / `diagnostics()`, the Sync panel) contain device ids, attempt counts,
timestamps and error text only. The relay sees device ids, session ids, tickets and ciphertext, never project content
(`server/test/p2p-e2e.test.ts` checks this). Tests: `packages/sync/test/connect-lifecycle.test.ts`,
`server/test/signal.test.ts` (leases, with a backend whose clock the test moves), `server/test/p2p-e2e.test.ts`.

## Frame format

`[type: u8][payload]`. The high bit (`0x80`) of `type` marks a deflate-raw compressed payload (used for payloads > 1 KiB,
never for blobs). Document frames use `[docIdLen: u16 BE][docId utf8][data]`.

## Message types

<!-- The table below is verified against packages/protocol by a test; keep names and values in sync. -->

| Value | Name | Payload |
|---|---|---|
| 0x01 | HELLO | JSON `{ticket, nonce}` |
| 0x02 | AUTH | JSON `{sig}` |
| 0x10 | STEP1 | doc frame: Yjs state vector (also signals interest in the document) |
| 0x11 | STEP2 | doc frame: Yjs update for what the requester is missing |
| 0x12 | UPDATE | doc frame: incremental Yjs update |
| 0x13 | AWARENESS | y-protocols awareness update (presence, cursors) |
| 0x20 | EPOCH | JSON `{epoch, ticket?}` – highest membership epoch seen, with the verified ticket that proves it (see below) |
| 0x21 | TICKET | JSON `{ticket}` – refreshed membership ticket |
| 0x30 | BLOB_HAVE | JSON `{hashes}` |
| 0x31 | BLOB_WANT | JSON `{hash, from, to}` – chunk range request |
| 0x32 | BLOB_CHUNK | `[hashLen u8][hash][index u32][total u32][bytes]` |
| 0x33 | BLOB_NONE | JSON `{hash}` |
| 0x40 | PEERS | JSON `{devices}` – peer exchange |
| 0x60 | APP | JSON `{topic, body}` – election, compile requests/results, GitHub backup coordination |

Types a `viewer` connection may send (everything else is dropped): `HELLO`, `AUTH`, `STEP1`, `AWARENESS`, `EPOCH`,
`TICKET`, `BLOB_WANT`, `BLOB_NONE`, `PEERS`, `APP`.

### Epoch authority and delayed authorization

* The enforced membership epoch only advances from a **verified ticket of this project** (signature, expiry, project id): a peer's
  own hello/refresh ticket, our own freshly issued ticket (verified the same way before it is shared), or the `ticket` attached to
  an `EPOCH` frame, which any member may relay. The epoch becomes the epoch *in the ticket*; the number beside it is ignored.
* An `EPOCH` frame without a ticket (legacy clients) or with a ticket that fails verification is only a **hint**: it never
  changes policy, is never rebroadcast, and prompts at most one ticket refresh per 30 s (`epochHintRefreshMs`).
* A receiver remembers each device's newest verified (epoch, issued-at) for the session, across connection replacement; a
  reconnect presenting an older ticket is refused (`stale device ticket`).
* Document frames that waited for the sync gate or a document load are applied only if the connection is still the device's
  active one and the sender is still not a viewer when they are applied. `APP` topics that are privileged (election `cap`/`beat`,
  `compiled`) are registered `editorOnly`, so the sender's role is checked when the message is dispatched.

## Authentication handshake

1. Both sides send `HELLO {ticket, nonce}`. The receiver verifies the ticket signature/expiry against the pinned control-plane
   keys and that it is for **this project**.
2. Both sides send `AUTH {sig}` where `sig = Ed25519(devKey, "hivetex/v1" ‖ projectId ‖ localDtlsFp ‖ remoteDtlsFp ‖ ownNonce ‖ peerNonce)`.
   Because both DTLS fingerprints are signed, a signaling server that swaps SDP (man-in-the-middle) cannot produce a valid
   proof.
3. Only after both proofs verify are any other frames accepted.

## Document model

* A **root document** holds the file table (`files: Map<fileId, {path, kind, hash?, size?}>`), `settings` (main file, engine)
  and `meta` (GitHub binding, backup progress). Files have stable random ids, so rename/move is a single field update and
  concurrent rename + edit converge without duplicates.
* Every text file is its own Yjs document (`f:<fileId>`), loaded lazily. Peers send `STEP1` only for documents they hold or
  open; the receiver treats a `STEP1` as *interest* and pushes later updates.
* Binary files appear in the table only as a SHA-256 content hash; bytes travel as chunks from any peer holding them and are
  verified against the hash before use. A receiver accepts a chunk only from a peer that announced the blob, and checks its
  length, index and the cumulative size before keeping it; a `BLOB_WANT` range must be finite non-negative integers
  and is clamped to the blob. If two sources disagree about the chunk count, each is retried alone; a source whose data does
  not match the hash is ignored and its advertised count is forgotten, so an honest source can still complete the fetch.
* Concurrent creation of the same path by two peers yields two files; the view shows the second as `name (2).ext`.
  Identical duplicates (e.g. both imported the same GitHub backup) are removed automatically, but only when both files are
  *complete* on this device and no request for them is in flight, and only if neither entry nor document changed between the
  comparison and the deletion. A listed file whose body has not arrived is never compared (its empty placeholder is not its content).

### Availability and reconciliation

Three questions are kept apart, because answering one says nothing about the others:

| Question | Source of truth | UI wording |
|---|---|---|
| Is the document's content *on this device*? | `ProjectModel.availability(docId)`: `unknown` / `partial` / `complete` | "received" |
| Are edits *saved* on this device? | `ProjectModel.saveState` (see offline.md) | "Saved on this device" / "not saved" |
| Have the *current peers answered* for it? | `Mesh.reconciled(docId)` (per connection) | "Checking with co-authors" / "All changes synced" |

* **Completeness.** A document is `complete` when it was created on this device (an empty file included), or a peer confirmed
  its full state (an empty answer included), or it was restored from storage as complete. A file-table entry, an allocated
  empty document, or an update that happened to arrive is at most `partial` (`unknown` with no content at all). It is recorded
  under the `availability` metadata key, written *after* the document's own edits so it never vouches for unsaved content.
  A store written before this existed has no record: its stored documents count as complete (they were all that device had);
  a fresh store starts an empty record. The file table (`root`) of a project made on this device is declared complete by the
  app (`markComplete`); a joined project's table is unknown until a peer confirms it.
* **Rounds.** `Mesh.reconcile(docId, {signal?, timeoutMs?})` asks every connected editor for the document and resolves
  `confirmed` (the document is now complete), `unavailable` (`no-peer`, or peers answered without being able to confirm),
  `timeout`, `cancelled` or `disconnected`. Viewers are never sources: their state is not applied. A round belongs to one
  connection and one request: replies to older requests, answers on other connections and incremental `UPDATE`s never complete it.
* **Receipts (negotiated, additive).** A client that supports them sends `APP` topic `sync-caps` `{v: 1, receipts: true}` right
  after the connection is authenticated. Its peer then accompanies each `STEP1` with `APP` `sync-req` `{docId, round}`; the
  answerer replies, after handling the `STEP1` and everything before it, with `sync-ack` `{docId, round, status}` where
  `status` is `complete` (it vouches that its copy is complete: the requester marks the document complete), `partial` (it holds
  some content) or `none`. Any applied answer means "this peer has nothing more than we now hold" (`reconciled`); only
  `complete` completes the document. The receiver applies the answer's frames before it honours the receipt.
* **Legacy peers (plain `STEP1`/`STEP2`).** Unknown `APP` topics are ignored, so old and new clients interoperate. Because a
  legacy `STEP2` cannot be matched to a request, at most one request per document is outstanding per legacy connection; later
  ones wait their turn. A `STEP2` completes the outstanding request (an empty `STEP2` from a legacy peer is taken as
  "empty"). Limitations: a legacy peer may itself hold partial content, a lost request blocks that document's later requests
  until it expires (`legacySlotMs`, 15 s, for requests nobody waits for), and a very late legacy reply can then answer a newer
  request. `UPDATE` never completes anything. New clients also stop answering a request for a file they merely know by name
  with an empty `STEP2` (they answer only if the file is empty *and* complete on their side).
* **Complete snapshots for consumers.** `Mesh.awaitComplete({signal?, timeoutMs?})` resolves at once when the file table and every
  text file are complete on this device (offline included); otherwise it reconciles what is missing and returns
  `{complete, docs, missing: [{docId, fileId?, path?, outcome}]}`. It never substitutes empty text. `Mesh.reconcileProject({scope})`
  (`incomplete` | `pending` | `all`) is the same with a chosen scope; `Mesh.resync()` is `scope: 'all'`. Binary content stays
  content-addressed: fetch the hashes of the captured file table with `BlobManager.fetch`. `Mesh.prefetchAll` keeps its older,
  non-awaiting meaning and is not a completeness guarantee (search still uses it, as it is harmless to search what is here).
* **Immutable acquisition.** `acquireProject(mesh, model, blobs, {timeoutMs?, assetTimeoutMs?, assets?})` (`snapshot.ts`) is what
  compilation, source export and backup call. It waits as `awaitComplete` does, then fixes in one synchronous step every
  text body (with its document revision), the file table with image hashes, the `main`/`engine` settings and
  `ProjectModel.changeSeq` (the number of updates seen; edits with a higher number are not in the capture), and only
  then fetches the images by the captured hashes. It returns `{complete: true, capture, assets}` or
  `{complete: false, missing: [{path, kind, hash?, outcome}]}`. `projectHash(capture)` is the identity of a capture (paths,
  text hashes, image hashes, main file, engine). `ProjectModel.captureSnapshot` (History) throws while text is missing.
* **Sync status.** `SyncTracker` derives its stage from the above: `receiving` while content is missing, `reconciling` when
  everything is here but a current peer has not answered for all of it, `synced` only when it has. `lastSyncAt` advances only
  on an applied answer (or a live update to an already answered document), never on a queued request. Every missing document or
  blob has its own record: it is retried when its sources change (a new device, a new connection, a new announcement, a new hash)
  or after a capped backoff (2 s doubling to 60 s), and has its own stall clock, so another file's activity cannot hide a stalled
  one. `SyncTracker.syncNow()` reports `complete`, `pending` (no answer in time), `failed` (peers cannot supply it) or `no-peer`.

## Persistence

Per-document append-only update log in IndexedDB, flushed within 250 ms, compacted after 500 updates; flushed on tab
hide/close. Local history snapshots (every ~10 min of activity) can be restored as ordinary edits.

## Large meshes

Up to 6 connections every update is sent directly by its author; above that, updates are relayed (gossip) – Yjs updates are
idempotent, so duplicates are harmless.

## Shareable project IDs

`POST /api/projects` retains its optional `slug` field as a name-prefix input. The server trims/lowercases it,
accepts 1–48 characters of a–z, 0–9 and hyphen, collapses repeated/edge hyphens and uses up to 31 prefix characters.
Omit it to use `project`. Each new share ID is `<prefix>-<16 random base32 characters>`, within 48 characters.
A caller-provided suffix does not replace server randomness. Read the canonical ID from `project.slug` in the response;
`project.id` is the separate immutable identity used in routes, local persistence and membership tickets.

Creation uses a unique database constraint and up to five fresh allocation attempts. Project and owner membership are
inserted atomically in one SQL statement on both PGlite and Neon HTTP. Exhaustion returns `id_generation_failed`
with a retry instruction; unrelated database failures remain internal failures rather than naming conflicts.

`PATCH /api/projects/:id` treats a changed `slug` as a new prefix and returns a fresh suffixed share ID. Submitting
the existing full ID is a no-op. Existing unsuffixed IDs remain valid for joining, listing, folder bindings and peers.
Older clients can create with their existing request field, but must use the returned slug when inviting or joining.

Production-driver allocation regression (isolated local services, not a hosted database): start the Compose project
`hivetex-identity-check` with `PG_PORT=55439 NEON_PROXY_PORT=4449` and the `postgres neon-proxy` services, then run
`HIVETEX_ALLOCATION_HTTP_TEST=1 pnpm --filter @hivetex/server exec vitest run test/project-allocation-http.test.ts`.
Stop that Compose project after testing; keep normal development containers and volumes separate.
