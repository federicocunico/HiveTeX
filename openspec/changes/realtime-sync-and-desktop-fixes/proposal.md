# Proposal

## Why

Real-time collaboration is the core promise, so it has to hold for a real group of co-authors. A first measurement
with the in-process mesh (12 peers, full mesh) showed that propagation itself is fast (< 1 ms of processing per hop,
concurrent edits from all peers converge in 12–62 ms). It also showed an amplification bug: once a device has more
than 6 connections, every received update is relayed to every other peer, even though the connection manager always
builds a full mesh. With 12 people each keystroke becomes 121 messages instead of 11 (N² instead of N-1). Nothing
measures this today, and no test covers more than 3 peers or real WebRTC latency.

The security review also found functional bugs:

- the hosted API answers no CORS preflight, so the desktop app (origin `tauri://localhost` / `http://tauri.localhost`)
  cannot sign in or fetch tickets from the deployed control plane;
- a Tectonic-only machine is advertised as able to compile XeLaTeX, wins the election, and then fails every build;
- registration returns 500 when the verification email cannot be sent, although the account has been created;
- the local Docker stack lets clients choose the IP used for rate limiting (`X-Forwarded-For`).

## What Changes

- **Relay without amplification**: devices share their neighbor list with peers. An update is forwarded only to
  peers that are not directly connected to the device it came from, so a full mesh sends exactly N-1 messages per
  edit and partial meshes (failed NAT pairs) still deliver everything.
- **Group-scale real-time tests and measurement**:
  - sync tests with 2–12 peers: keystroke propagation time, messages per edit, concurrent typing by everyone, late
    joiner and partial-mesh delivery;
  - a browser e2e test with 7 users connected over real WebRTC that measures keystroke latency (p50/p95) and
    convergence under concurrent typing;
  - `make bench`, which prints the numbers; results go in `docs/performance.md`.
- **Desktop ↔ hosted API**: CORS for the desktop origins only (no credentials, bearer tokens), so the desktop app works
  against the deployed control plane.
- **Tectonic**: compile with `tectonic -X compile` (untrusted mode, SyncTeX) when it is the only engine available.
- **Registration**: the verification email is sent in the background; a mail failure no longer fails registration.
- **Stack**: nginx passes the real client address instead of appending to a client-supplied `X-Forwarded-For`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `peer-sync`: adds a requirement for real-time propagation at group scale (latency and bounded messages per edit).
- `latex-workspace`: the desktop app must work against the hosted control plane (cross-origin API access).
- `distributed-compilation`: engine selection covers Tectonic-only devices.
- `user-accounts`: registration succeeds even if the verification email cannot be sent right away.

## Impact

- `packages/sync/src/mesh.ts` (neighbor list, relay rule), new sync tests and a benchmark script.
- `e2e/realtime.spec.ts` (7 browser contexts); `Makefile` (`bench`); `docs/performance.md`.
- `server/src/app.ts` (CORS middleware), `server/src/accounts/routes.ts` (background email).
- `apps/desktop/src-tauri/src/tex.rs` (Tectonic path), Rust tests.
- `docker/nginx.conf.template`.
- Wire protocol: new APP topic for neighbor lists (old clients ignore it and fall back to the old relay rule).
