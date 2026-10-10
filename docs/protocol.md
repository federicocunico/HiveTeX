# Wire protocol and sync model

## Transport

Each pair of devices talks over WebRTC with two reliable, ordered data channels:

* `sync` – handshake, CRDT updates, awareness, control and compile messages;
* `bulk` – binary blobs (images, PDFs).

Messages larger than 16 KiB are fragmented (1 byte header: single / first / middle / last) and sends honor
`bufferedAmount` back-pressure (1 MiB high-water mark). Signaling messages (SDP/ICE) are end-to-end encrypted between the
two devices (X25519 → HKDF → AES-256-GCM) before they touch the relay.

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
| 0x20 | EPOCH | JSON `{epoch}` – highest membership epoch seen |
| 0x21 | TICKET | JSON `{ticket}` – refreshed membership ticket |
| 0x30 | BLOB_HAVE | JSON `{hashes}` |
| 0x31 | BLOB_WANT | JSON `{hash, from, to}` – chunk range request |
| 0x32 | BLOB_CHUNK | `[hashLen u8][hash][index u32][total u32][bytes]` |
| 0x33 | BLOB_NONE | JSON `{hash}` |
| 0x40 | PEERS | JSON `{devices}` – peer exchange |
| 0x60 | APP | JSON `{topic, body}` – election, compile requests/results, GitHub backup coordination |

Types a `viewer` connection may send (everything else is dropped): `HELLO`, `AUTH`, `STEP1`, `AWARENESS`, `EPOCH`,
`TICKET`, `BLOB_WANT`, `BLOB_NONE`, `PEERS`, `APP`.

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
  verified against the hash before use.
* Concurrent creation of the same path by two peers yields two files; the view shows the second as `name (2).ext`.
  Identical duplicates (e.g. both imported the same GitHub backup) are removed automatically.

## Persistence

Per-document append-only update log in IndexedDB, flushed within 250 ms, compacted after 500 updates; flushed on tab
hide/close. Local history snapshots (every ~10 min of activity) can be restored as ordinary edits.

## Large meshes

Up to 6 connections every update is sent directly by its author; above that, updates are relayed (gossip) – Yjs updates are
idempotent, so duplicates are harmless.
