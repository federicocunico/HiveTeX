# Tasks

## 1. Reproduction in the relay e2e test

- [x] 1.1 In `server/test/application-relay-e2e.test.ts`, add a helper that delays `backend.getPresence` by N ms (D4).
  - Add a variant of the 12-peer test with a 15 ms delay that also checks that summed `retransmits` < summed `sentFragments`.
  - Verify it fails on the current code: the texts don't converge, or retransmits ≥ sends.

## 2. Adaptive retransmission timeout

- [x] 2.1 In `packages/sync/src/relay-transport.ts`, record the first send time per inflight fragment.
  - Update SRTT and RTTVAR only from ACKs of fragments that were never retransmitted (Karn).
  - Compute the RTO as in D1, with `rtoMs` as the initial value, a 500 ms floor and a 30 s cap; keep backoff and `maxRetries`.
  - Expose `srttMs` and `rtoMs` in `RelayTransportStats`.
  - Verify with new `packages/sync/test/relay-transport.test.ts` cases using fake timers:
    - delayed ACKs raise the RTO, and a frame acknowledged after 2 s with an RTT of about 2 s is not retransmitted;
    - samples from retransmitted fragments are ignored;
    - a dead peer still fails after `maxRetries`.

## 3. Congestion window

- [x] 3.1 Add the frame-count `cwnd` and `ssthresh` as in D2: start at 16, slow start, then congestion avoidance, floor 2, ceiling 256.
  - The pump sends only while frames in flight < `cwnd` and the byte window allows it.
  - Expose `cwnd` in the stats.
  - Verify with unit tests:
    - the first flight is capped at 16 small messages;
    - the window grows with ACKs;
    - several timeouts from one flight halve it only once;
    - bulk still can't fill the whole window.
- [x] 3.2 Run the existing relay suites unchanged and confirm they pass: `packages/sync/test/relay-*.test.ts`, `server/test/application-relay*.test.ts` and `server/test/relay-*.test.ts`. They cover assets, limits and handover.

## 4. Recipient drop notice

- [x] 4.1 In `server/src/signal/application-relay.ts`, a per-recipient overflow sends `relay-error{code:'relay_inbound_dropped'}` with no `retryAfterMs`, at most once per second per attachment, metered as `relay.error.relay_inbound_dropped`.
  - Update `server/test/application-relay.test.ts` to expect the new code and the rate limit (300 overflowing publishes → one notice).
  - Verify the server tests pass.
- [x] 4.2 In `packages/sync/src/connect.ts`, keep `relay_inbound_dropped` out of `RELAY_LIMIT_CODES` and call `noteInboundDrop()` on every relay transport. `relay_backpressure` keeps today's handling, for old servers.
  - In the transport, carry `d:1` on the next ACK batch and treat a received `d` as a loss event (once per flight).
  - Verify with unit tests:
    - an inbound-drop notice doesn't set `limitedUntil`;
    - the peer's `cwnd` drops after an ACK with `d`;
    - an ACK without `d` (an old peer) is handled as before.
- [x] 4.3 Document the new code, the ACK `d` field, the adaptive RTO and the window in `docs/protocol.md` (relay section, around "a missing ACK triggers a retransmission") and in `docs/deployment.md` where relay errors are listed.
  - Verify the docs describe the behaviour the unit tests check.

## 5. Integration

- [x] 5.1 Remove `retry: 2` and its comment from the 12-peer test.
  - Verify that both the normal and the 15 ms variants pass 5 times in a row on 2 CPUs (`start /affinity 3`), and that the full server suite passes on 2 CPUs.
- [ ] 5.2 Close the `TODO_CI.md` item about the 12-peer relay test.
  - Verify CI is green on the commit (the `checks`, `data-safety-browser` and `Desktop` workflows).

## Workflow follow-up

- Archive the change after CI is green, and sync the `peer-sync` delta into the main spec.
