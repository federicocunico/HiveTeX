# Design

## Context

Current state of `RelayTransport` (`packages/sync/src/relay-transport.ts`), one per relayed peer:
- It seals 16 KiB fragments, gives each one its own retransmission timer (`rtoMs` 1.5 s, doubling, `maxRetries` 6), and limits only *bytes* in flight (`windowBytes` 64 KiB).
- Sync messages are mostly small (Yjs updates, STEP1/2, awareness), often around 100 bytes. A 64 KiB byte window therefore allows hundreds of frames in flight per peer.
- With 11 senders towards one device, a burst can far exceed the router's per-recipient queue (`server/src/signal/application-relay.ts`: 256 messages or 4 MiB), which drops the overflow.

Receivers acknowledge every copy in batches (`{a:[counters]}`, 20 ms delay). Measured under a 15 ms delivery delay:
- `duplicateFragments` is close to `retransmits`. Most retransmissions resend frames that were only late, not lost, because the fixed 1.5 s timeout is shorter than the queueing delay.

The recipient's overflow currently sends that recipient `relay-error{code:'relay_backpressure', retryAfterMs:30000}`:
- `connect.ts` handles it with `noteLimited` on every relay transport;
- this delays all of that device's retransmissions by 30 s.

The hub (`server/src/signal/hub.ts`) uses the same code for its own *sender-side* queue, with `retryAfterMs: 1000`. That use is correct.

See proposal.md for why this matters.

## Goals / Non-Goals

**Goals:**
- Under overload, retransmissions stay fewer than first sends, and frames that are only delayed are not resent.
- The 12-peer relay test converges with a 15 ms per-delivery delay and no retry.
- Mixed versions keep working. New and old clients and servers interoperate without new mandatory messages.

**Non-Goals:**
- Fair scheduling across senders at the router, or raising the router's queue limits.
- Changing relay budgets, `relay_limited` or accounting behaviour.
- Selective acknowledgement or forward error correction. Today's per-fragment ACKs are kept.

## Decisions

### D1. RTT estimation per RFC 6298 with Karn's rule

The retransmission timeout comes from the measured round trip:
- each inflight fragment records its first send time;
- an ACK for a fragment that was never retransmitted gives an RTT sample;
- SRTT and RTTVAR are updated with α=1/8 and β=1/4;
- RTO = clamp(SRTT + 4·RTTVAR + ackDelay, minRto, maxRto).

Parameters:
- `rtoMs` stays as the initial RTO, before any sample;
- minRto (`minRtoMs`) defaults to min(500 ms, `rtoMs`), so a fast, quiet path doesn't retransmit too eagerly. Tests and harnesses that configure a short `rtoMs` keep it;
- maxRto is 30 s;
- `maxRetries` is unchanged, so a dead relay still fails within bounded time.

There are two backoffs, kept separate so they don't compound:
- *First transmissions* use a backed-off RTO. It doubles once per lost flight (RFC 6298 §5.5) and returns to the measured RTO with the next clean sample. Without it, a path slower than the initial RTO would never yield a sample (Karn).
- *Retransmissions* of a fragment wait the measured RTO × 2^tries.

In the implementation the two first compounded: after a few lost flights a single retry could wait 30 s, and the loss test stalled. Splitting them fixed it.

*Alternative:* only raise the fixed `rtoMs`. It would be simpler, but it slows recovery on healthy paths and fails again on slower hosts.

### D2. Frame-count congestion window, AIMD

`cwnd` counts frames, and a fragment may be sent only if both conditions hold:
- frames in flight < `cwnd`;
- bytes in flight respect the existing byte window.

The window evolves like this:
- it starts at 16 frames;
- below `ssthresh` it grows by 1 per ACK (slow start), then by 1/cwnd per ACK;
- on a loss event, `ssthresh` = max(2, cwnd/2) and `cwnd` = `ssthresh`;
- the floor is 2 frames and the ceiling 256.

Several fragments timing out from the same flight count as one loss event. The transport records the highest counter sent when it reduced, and ignores further timeouts of fragments at or below it.

Retransmissions don't consume new window. They fire from their timers as today, but no new fragments are sent while frames in flight ≥ `cwnd`.

*Why 16 frames:* 11 peers × 16 = 176, which fits within the router's 256-message queue at start-up.

*Alternative:* a fixed small frame cap. That's the simplest bound, but it throttles a single fast peer forever. AIMD adapts to the number of peers and to the host.

### D3. Recipient-side drop notice, signalled to senders through ACKs

Server: the per-recipient overflow sends `relay-error{code:'relay_inbound_dropped'}` with no `retryAfterMs`, at most once per second per attachment, and meters it as `relay.error.relay_inbound_dropped`.

`connect.ts`:
- `relay_inbound_dropped` is not in `RELAY_LIMIT_CODES`;
- it calls `noteInboundDrop()` on every relay transport of that device, because the recipient can't tell whose frames were dropped.

The transport then adds `d:1` to its next ACK batch:
- a sender that receives an ACK with `d` treats it as a loss event (D2), subject to the same once-per-flight rule;
- old senders ignore the unknown field, because ACK parsing reads only `a`;
- old servers keep sending `relay_backpressure`, and new clients keep treating it as a limit for compatibility. That case only arises against an old server, and the behaviour is unchanged from today.

*Alternative:* a server-side notice to the senders. The router does know the senders (`from`), but notifying them costs more cross-instance publishes during the very overload being handled. Through ACKs the signal is free and end-to-end authenticated.

### D4. Test reproduction without product hooks

`server/test/application-relay-e2e.test.ts` wraps `backend.getPresence` with a configurable delay, as `application-relay.test.ts` already does. Every relay delivery waits on it, so the overload is reproduced without any production code path.

The 12-peer test runs:
- once at normal speed;
- once with a 15 ms delay, asserting convergence, `retransmits < sentFragments` summed over transports, and that the frames-per-edit check still holds.

Then `retry: 2` is removed.

## Risks / Trade-offs

- [A smaller window slows large single-peer transfers over the relay] → the window grows multiplicatively during slow start, and the byte window still bounds bulk. Check with the existing relay asset transfer tests.
- [Spurious loss events from ACK batching on a busy event loop] → the RTO includes `ackDelay` and has a 500 ms floor, and there's at most one reduction per flight.
- [Under heavy random loss in both directions (the unit test's 33%), the tail of a transfer recovers more slowly than with the old fixed 30 ms timer: the window shrinks and the last fragments back off from the measured timeout] → relay loss in practice comes from overload, where backing off is the point. The unit test's drain limits were raised from 4–8 s to 20 s.
- [Mixed versions: a new sender towards an old receiver gets no `d` signal] → the sender still reacts to timeouts with D1 and D2, so it degrades to "adaptive but timeout-driven".
- [The 15 ms CI scenario adds test time] → under 20 s, judging by the current runs, and it replaces a retry that could triple the time.

## Migration Plan

The client and server parts are independent and additive. They can deploy in any order:
- a new server with old clients: old clients ignore `relay_inbound_dropped` and lose today's 30 s pause, which was harmful anyway;
- a new client with an old server: unchanged handling of `relay_backpressure`.

Rollback means reverting either side.
