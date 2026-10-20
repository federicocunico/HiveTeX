# Proposal

## Why

When many peers start syncing through the application relay at once on a slow host, the relay collapses instead of slowing down. The 12-peer relay test failed in CI this way (commit bb3f227), and adding 5–15 ms per relay delivery reproduces it locally. Three things happen:
- the start-up burst overflows the router's per-recipient queue (256 messages);
- senders retransmit on a fixed 1.5 s timer, and retransmissions end up outnumbering first sends;
- the overloaded recipient is told `relay_backpressure` with `retryAfterMs: 30000` and pauses its own retransmissions on every relay link, even though only the senders can repair the loss.

Removing that pause alone made the retransmission storm worse, which was measured. So the transport needs real congestion control. For now CI only stays green because the test is retried.

## What Changes

- **Adaptive retransmission timeout.** The relay transport derives its timeout from measured acknowledgement round-trip times, ignoring retransmitted fragments (Karn's rule). It keeps exponential backoff and a cap.
- **Congestion window.** The window limits frames in flight, not just bytes:
  - it shrinks when a loss is detected, by timeout or by an inbound-drop notice;
  - it grows again as acknowledgements arrive;
  - the existing 64 KiB byte window remains as an upper bound.
- **Recipient-side drop notice.** When the router drops frames for a recipient whose queue is full, it sends that recipient an informational `relay_inbound_dropped` notice, at most once per second. This is not a forwarding limit, so the recipient no longer pauses its own sending. A recipient that receives it signals senders through its ACK stream, for example by advertising a reduced receive window.
  - The sender-side `relay_backpressure` sent by the hub (`retryAfterMs: 1000`) keeps its meaning.
- **Remove the CI retry.** Once the 12-peer test passes under the delayed-delivery reproduction, its `retry: 2` comes out. The delay becomes a test option, so the scenario stays covered.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `peer-sync`: the "Bounded reliable application relay delivery" requirement gains congestion behaviour:
  - senders adapt their sending rate and retransmission timing to observed loss and delay;
  - a receiver overload is reported as a drop, not as a forwarding limit;
  - many peers starting at once through the relay converge on a slow host.

## Impact

- `packages/sync/src/relay-transport.ts`: RTT estimation, congestion window, and handling of drop notices and the receive window.
- `packages/sync/src/connect.ts`: `RELAY_LIMIT_CODES` and the handling of `relay-error`. `relay_inbound_dropped` is routed to the transports and not treated as a limit.
- `server/src/signal/application-relay.ts`: the recipient overflow sends a rate-limited `relay_inbound_dropped` instead of `relay_backpressure` with 30 s.
- Tests:
  - `server/test/application-relay-e2e.test.ts`: delayed-delivery option and retry removed;
  - `server/test/application-relay.test.ts`: the expected recipient-side code changes;
  - new unit tests for the RTT, window and drop logic in `packages/sync/test`.
- Compatibility:
  - older clients ignore the unknown `relay_inbound_dropped` code, which is better than their current 30 s pause;
  - if new clients advertise a receive window in ACKs, it must stay additive, and peers that don't send one keep today's behaviour.
- Docs: `docs/protocol.md` (relay errors, ACK fields) and `TODO_CI.md` (close the open item).
