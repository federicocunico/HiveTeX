# Real-time performance

p2platex promises real-time collaboration: an edit should appear on every co-author's screen within a blink, for
a realistic group of authors. This page records what was measured, how, and how to measure it again.

## Results (2026-10-09, Windows 11, Node 22, Chromium 1.64)

### Browsers over real WebRTC: `e2e/realtime.spec.ts`

Seven users in one project, each in their own browser context, connected peer to peer over WebRTC on one machine.
One user types 30 markers with 100 ms pauses. Each marker is timed from the edit to the moment it appears in each of
the six other users' editor DOM, which covers Yjs, framing, the WebRTC data channel, the remote Yjs and CodeMirror
rendering.

| run | keystroke → screen p50 | p95 | max | 7 users × 10 concurrent edits converge |
|---|---|---|---|---|
| 1 | 2.8 ms | 8.7 ms | 11.3 ms | 252 ms |
| 2 | 2.7 ms | 4.2 ms | 5.9 ms | 316 ms |
| 3 | 3.1 ms | 8.1 ms | 9.4 ms | 364 ms |
| 4 | 3.0 ms | 5.3 ms | 9.3 ms | 292 ms |

About 200 ms of the convergence time is the typing pauses inside the test itself. The test asserts p95 < 250 ms (the
spec) and that every user ends with identical text containing all 70 concurrent insertions.

### Sync stack at group scale: `make bench`

In-memory transport, full mesh. "Immediate delivery" shows the cost of p2platex's sync stack itself. The second table
simulates 20 ms one-way network latency (Windows rounds `setTimeout(20)` up to ~31 ms).

Sync stack only:

| peers | keystroke p50 | p95 | max | messages per keystroke | all peers type 20 chars at once: converged |
|---|---|---|---|---|---|
| 2 | 0.05 ms | 0.39 ms | 0.68 ms | 1 | 2 ms |
| 4 | 0.07 ms | 0.13 ms | 0.35 ms | 3 | 6 ms |
| 6 | 0.11 ms | 0.57 ms | 1.03 ms | 5 | 14 ms |
| 8 | 0.15 ms | 1.19 ms | 2.59 ms | 7 | 32 ms |
| 10 | 0.10 ms | 0.32 ms | 0.53 ms | 9 | 30 ms |
| 12 | 0.15 ms | 0.79 ms | 1.02 ms | 11 | 63 ms |
| 16 | 0.15 ms | 0.35 ms | 1.30 ms | 15 | 101 ms |

With 20 ms one-way latency (≈31 ms after timer rounding):

| peers | keystroke p50 | p95 | messages per keystroke | converged |
|---|---|---|---|---|
| 2 | 31.0 ms | 31.8 ms | 1 | 47 ms |
| 6 | 31.0 ms | 31.8 ms | 5 | 39 ms |
| 8 | 31.2 ms | 32.2 ms | 7 | 43 ms |
| 12 | 30.9 ms | 32.9 ms | ≤ 14 | 67 ms |
| 16 | 30.9 ms | 32.3 ms | 15 | 121 ms |

**Takeaway:** propagation equals the network's one-way latency plus well under 1 ms. A full mesh sends each edit
exactly once per connection (N-1 messages). On real networks, expect "one-way latency between the two authors"
(typically 5–60 ms in the same country) plus about 3 ms for rendering.

## What was fixed while measuring

The first measurement found two relay bugs:

1. **Quadratic traffic.** With 7 or more connections, every device re-forwarded every received edit to all its other
   peers, so a keystroke cost (N-1)² messages: 121 for 12 people.
2. **No relay in small partial meshes.** With fewer than 7 connections nobody forwarded, so when two authors could not
   connect directly (NAT), their edits never reached each other live.

Devices now announce their direct neighbours, and an edit is forwarded only to peers that the sender is not connected
to (`packages/sync/src/mesh.ts`, `shouldRelay`). This gives N-1 messages per edit in a full mesh and still delivers
through partial meshes and chains. After a link drops, state vectors are re-exchanged to fill any gap. Tests:
`packages/sync/test/scale.test.ts` covers 2–12 peers, one missing pair, a 5-device chain and a late joiner.

## How to measure again

```bash
make bench                         # sync stack, 2..16 peers (LATENCY_MS=40 make bench to change the simulated latency)
pnpm exec playwright test e2e/realtime.spec.ts   # 7 browsers over WebRTC; prints [realtime] lines
```

Real internet paths (different cities, behind NAT, TURN relay) cannot be reproduced in CI. To check them manually,
open the same project from devices on different networks, type in one, and watch the others. The status bar shows
how many peers are connected.
