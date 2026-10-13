# Application relay security and P2P boundary

The application relay is a fallback for peers that cannot establish a usable WebRTC path. Healthy direct links carry project updates and assets without sending those contents through the central server. Existing peer exchange, neighbour announcements and sparse-mesh forwarding remain device-to-device. A discovery gatekeeper and periodic membership renewal still require the control plane; this is not a permissionless BitTorrent network.

The regression in connect-lifecycle.test.ts verifies no new signaling messages during direct edits and continued edits during a signaling socket outage. It uses simulated RTC; packaged-app/NAT and provider usage acceptance remain outstanding.

## Protocol and threat model

An operator or network intermediary can observe routing metadata, interrupt traffic, replay envelopes or substitute introductions. It must not read or modify project data, impersonate a member using a copied ticket, or move traffic between projects/generations. Endpoint compromise and a compromised trusted membership issuer are outside this transport boundary. Availability and traffic analysis are not hidden.

The endpoint first validates its own current ticket and expected peer device. Each side generates a fresh X25519 secret, 32-byte challenge and 32-byte generation. The hello carries version, initiator/responder role, current ticket and those public values. The canonical transcript is a JSON array of the protocol domain, project and ordered initiator/responder entries. Each entry includes handshake role, user/device IDs, ticket signing/exchange keys, the exact ticket, ephemeral public key, challenge and generation. JSON array encoding avoids delimiter ambiguity.

Each side signs the transcript's SHA-256 hash and its handshake role with the ticket-bound Ed25519 key. HKDF-SHA-256 binds the hash in salt and info and derives different keys for each direction and for data versus HMAC key confirmation. Both possession proof and remote confirmation must succeed before a session is returned. A transport may expose that confirmed transcript hash through the explicit relay binding only after this step. The subsequent PeerConnection proof uses a separate relay domain; legacy WebRTC retains its exact existing DTLS proof bytes.

See [X25519 key agreement](https://www.rfc-editor.org/rfc/rfc7748.html#section-6.1) and [HKDF context binding](https://www.rfc-editor.org/rfc/rfc5869.html#section-3.2). Existing noble and WebCrypto primitives implement the operations. Invalid or all-zero X25519 secrets are rejected.

## Lifetimes and regression evidence

| Material or state | Lifetime and checks | Regression evidence |
| --- | --- | --- |
| Device signing keys | Existing identity lifetime; never sent to relay; both ticket keys checked at local setup | Copied-ticket and substituted-ticket rejection |
| X25519 ephemeral secret | One handshake; overwritten after derivation, failure, explicit close or ten-second timeout | Reconnect generates different keys; malformed/low-order input and expired-handshake tests |
| Signed transcript | Fresh identities, tickets, keys, challenges, generations and roles; hash retained as channel binding | Substitution, wrong project/device, reflection, old-generation proof tests |
| Confirmation keys | Directional HMAC; only retained during handshake, dropped before session handoff | Out-of-order handshake and reflected confirmation tests |
| Data keys | Non-extractable AES-256-GCM keys for one confirmed generation; references dropped on close/expiry | Cross-session, own-direction and closed/expired-session tests |
| Nonces | Derived four-byte prefix plus eight-byte counter, separate directional keys; session closes before 2^32-1 sends | Concurrent seal ordering and counter exhaustion tests |
| Frame context | Project, session hash, sender/recipient, type, channel, message, fragment/count and counter are AAD | Changed context/ciphertext tests; forged input does not consume replay state |
| Replay tracking | 1,024-counter receive window; authenticate retries, suppress duplicate application delivery | Reordering, concurrent duplicate, stale-window and cross-session tests |
| Queued decryption | At most 256 frames / 4 MiB of encoded ciphertext; max 16 KiB plaintext per frame | Fragment size tests; transport backpressure remains a separate acceptance gate |
| Authorization | Current PeerConnection role and Mesh epoch checks; session ticket expiry also checked around crypto awaits | Encrypted mesh viewer, delayed-demotion and stale-membership reconnect tests |

Review performed during implementation: checked canonical ordering and domain separation, directional key usages, nonce reservation before asynchronous encryption, close checks after asynchronous work, authenticated replay-window advancement, bounded decoding, and unchanged legacy DTLS bytes. Added a post-decompression closed check and prevented late handshake/ticket verification from reviving a closed connection. Ticket refresh cannot change the device exchange key.

JavaScript cannot promise physical erasure of runtime-internal copies or WebCrypto key memory. Raw ephemeral/shared-secret arrays are overwritten and key references released; no stronger erasure guarantee is claimed. Session keys do not extend ticket validity: reconnect/rekey with fresh tickets instead of reviving an expired generation.

## Deployment gate

The server side is implemented: capability negotiation, recipient-scoped routing, admission guards, distributed credits (`server/src/signal/relay-budget.ts`) and the no-retention check (`server/test/relay-retention.test.ts`). Production forwarding stays off until a deployment sets `APPLICATION_RELAY=1` with measured headroom ([deployment.md](deployment.md#application-relay)). Reliable bounded client delivery, route handover and real-network acceptance must still pass before enablement. A ciphertext ACK is not a durable-save or full-project-sync receipt. Direct connectivity must remain preferred and must survive application-relay quota exhaustion.
