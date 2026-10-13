# Design

## Context

Evidence: see proposal.md (Why). The full measurements, the lab kit and the run logs are summarized below so the
decisions can be checked against them.

**What already exists and works**
- Signaling: server acknowledgement and delivery receipts, deaf-subscription recovery, early-candidate buffering, a
  connection trace on every side, `make sandbox-sync` (this PC + Windows Sandbox, merged timeline).
- Application relay: end-to-end encrypted frames over the signaling WebSocket, authenticated per session, bounded,
  budgeted (Upstash `eval`), negotiated (`r1_` session ids). Client side on by default; server side off unless
  `APPLICATION_RELAY=1` plus `RELAY_PROVIDER_COMMANDS` / `RELAY_BASELINE_COMMANDS` (`relayLimitsFromEnv`).
- Today the client starts the relay 8 s after seeing a relay-capable peer, and only after a failed WebRTC attempt when
  TURN is configured (`scheduleRelay`, `turnConfigured()` gate). When a direct link authenticates, the mesh replaces the
  relay connection at once and the relay generation is dropped (`onPeerJoin`).

**What the investigation measured** (2026-10-13, same lab, same ExpressTURN account)

| Run | Outcome |
|---|---|
| Browser libwebrtc, relay only over UDP / over TCP | connected in ~190 ms (relay↔relay), 44/45 pings answered over 45 s |
| Browser libwebrtc, all candidates / STUN only | direct in < 20 ms, stable 45 s; Chromium gathers 1 host candidate |
| Native webrtc-rs 0.13, local server + TURN (5 runs) | first attempt `checks-failed` at 20 s in 4/5; connected pairs were direct `srflx↔host` and went `disconnected` ~5 s later; relay pairs never selected after 16:19 |
| Native, production server (after the signaling fixes) | signaling acknowledged and delivered every time; 3 attempts `checks-failed`, the 4th connected and died 5 s later; no sync in 4 min |
| Native + application relay, STUN only | relay at 9 s, all sync checks pass |
| Native + application relay, with TURN | relay at 21 s (waits for the failed attempt), all sync checks pass |

**Native stack facts** (code and upstream): webrtc-rs 0.13 with a vendored `webrtc-ice` (UDP mux patch only);
`SettingEngine::default()` otherwise: disconnected 5 s, failed 25 s, keepalive 2 s, 7 binding requests per pair,
UDP only, every interface (11 host candidates on this PC: VPN and Hyper-V adapters included); TURN over UDP only
(`turn:...?transport=tcp` and `turns:` skipped, upstream #539 closed "not planned", #848 open on 0.20); no pair
failover after the selected pair dies (pion lineage; renomination only recently in pion v4); no logger, so its own
`log::warn!` lines are lost; ICE connection state not forwarded; `iceTransportPolicy` not forwarded. The client gives
up on an attempt at 20 s, before the stack's own 25 s failure timeout.

## Goals / Non-Goals

**Goals:**
- Two members who both reach the server sync within seconds, whatever the network, the NAT type, the VPN or the
  native stack does.
- Direct WebRTC stays an optimization that removes server traffic when it is healthy, never a precondition.
- When the native stack fails again, the report says why in its own words.

**Non-Goals:**
- Replacing the native WebRTC stack (evaluated in a decision record only).
- Self-hosted relay servers, TURN over TLS 443 for the desktop (not possible with webrtc-rs today), WireGuard.
- Changing the application relay's protocol, encryption or authentication.

## Decisions

### 1. Relay first, direct as an upgrade

Start the application relay as soon as both peers are seen on the server and relay-capable (lower id initiates, as
today), with no 8 s delay and no TURN gate. Run WebRTC in parallel. Rationale: every measured failure was in the
WebRTC path, every measured relay session worked; Tailscale, iroh and Syncthing use the same order. Alternative: keep
"direct first, relay as fallback" with a shorter deadline (e.g. 3 s): rejected, because attempts that later die (the
5 s drop) would still interrupt sync, and the deadline would race the stack's checks.

### 2. A direct link becomes the route only after probation

When a WebRTC link authenticates while a relay route exists, keep the relay as the route and run a probation on the
new link: application-level pings both ways over its data channel for 8 s (longer than the 5 s disconnected timeout
that killed the lab links). Only then hand over through the existing mesh replacement. Without a relay route (relay
disabled or refused) the link is used at once, as today. Alternative: hand over immediately and keep the relay
session as a hot standby: rejected for now, the mesh holds one authoritative connection per peer and a standby doubles
relay sockets for the whole session.

### 3. Silent direct links hand back at once

On `disconnected` (or missing pong) of the route link, schedule the relay immediately (`scheduleRelay(dev, 0)`) while
the 10 s grace for the link itself continues (`link.lost` exists since b8768d8). Relay setup measured ~1 s. Yjs
updates are idempotent, so edits sent on both paths during the switch converge.

### 4. Native attempts bounded by the native stack

Set the native ICE timeouts explicitly (`set_ice_timeouts`: disconnected 5 s, failed 20 s, keepalive 2 s) and keep the
client's link timeout above them (30 s), so relay pairs get the full window. Alternative: leave defaults and raise the
client timeout only: rejected, explicit values make the behaviour independent of upstream defaults.

### 4b. Relay-only attempts after failed checks (added after the lab)

`make rtc-lab` showed native↔native failing with all candidates but connecting relay-only (TURN over UDP) in about
2 s, every time. With TURN configured, every other attempt after one whose checks failed is relay-only. A TURN route
then replaces the application relay after its probation, so relayed editing spends ExpressTURN's bandwidth (1000 GB
free) instead of Upstash commands (about 5 per frame, 500K per month on the free plan). The interface-filtering spike
(decision 6) did not help and was not adopted (docs/decisions/native-webrtc.md).

### 5. Native stack visibility

A bounded in-memory logger in the desktop process captures `webrtc_ice`, `webrtc` and `turn` records at info/warn,
masks IP addresses and drops anything carrying credentials, and is exposed to the worker and the report next to the
connection trace. ICE connection state and selected-pair changes are forwarded as bridge events.
`iceTransportPolicy: 'relay'` is forwarded to the native peer for the relay-only peer test. Alternative: env_logger to
stderr: rejected, release builds on Windows have no console and users cannot attach logs.

### 6. Interface filtering only if measured

Chromium gathers host candidates on the default-route interface only; webrtc-rs gathers eleven here. Whether filtering
virtual adapters improves native success is measured in `make rtc-lab` before it is adopted (it can also remove the
only working path when the VPN is the route). The spike's result is recorded either way.

### 7. Production relay enabled from measurements

Measure baseline and relay command usage with `USAGE_LOG=1` (and the sandbox runs), set `APPLICATION_RELAY=1`,
`RELAY_PROVIDER_COMMANDS` (Upstash plan), `RELAY_BASELINE_COMMANDS` and per-account limits through `scripts/setup.mjs`;
document the cost per relayed MiB (~600 Upstash commands) and per relay hour (Vercel socket time). The gates listed in
`docs/application-relay-security.md` (bounded delivery, route handover, real-network acceptance) are the acceptance:
`make sandbox-sync` scenarios and a two-PC test.

### 8. Lab tooling in the repository

The browser-vs-native lab used for this investigation (minimal signaling server, test page, Windows Sandbox runner)
moves into `apps/desktop/e2e/rtclab` as `make rtc-lab`, with a native peer added (the desktop test build driven over
DevTools, using the bridge directly with a forced transport policy). `make sandbox-sync` gains a hold phase (edits for N
minutes, convergence checked continuously) and a scenario matrix (STUN only, TURN, relay off/on, deaf session).

### 9. Native stack replacement: decision record only

`docs/decisions/native-webrtc.md` compares the webview's own WebRTC (WebView2/WKWebView: libwebrtc, available only
while a webview exists; WebKitGTK uncertain), iroh 1.x (QUIC + own HTTPS relay, browsers relay-only via WASM),
webrtc-rs 0.20 (TCP ICE, still no TURN TCP/TLS) and libdatachannel, against: `make rtc-lab` success equal to the
browser, TURN TCP/TLS, pair failover, maintenance, platforms, binary size, effort. No replacement is made here.

## Risks / Trade-offs

- [Every collaboration starts on the server: cost] → relay budgets fail closed and are visible; direct upgrade after
  8 s probation removes the relay for healthy pairs; measured cost documented before enabling.
- [Vercel closes sockets at 300 s: relay rehandshake every ~280 s] → already handled by the relay protocol (fresh
  authorization, reconciliation); the hold phase of `sandbox-sync` checks continuity across a rotation.
- [Upstash outage or deaf subscription] → sessions close and reconnect (subscription loss handling); direct links, once
  proven, need no server.
- [Probation delays the direct path by 8 s] → the relay carries edits meanwhile; no user-visible wait.
- [Duplicate delivery during switches] → Yjs updates are idempotent; reconciliation already runs after transport
  changes.
- [Native log volume or leaks] → bounded ring, info/warn only, IP masking, credential-bearing records dropped; tests
  assert no TURN username or credential appears.

## Migration Plan

1. Ship server and client changes with the relay still off in production; older clients keep direct-then-TURN.
2. Measure, set the relay environment, deploy (`vercel --prod` with a commit authored by the team member's address).
3. Run `make sandbox-sync` against production and the two-PC test; rollback by unsetting `RELAY_PROVIDER_COMMANDS`
   and redeploying (clients fall back to WebRTC only).

## Open Questions

- Probation length (8 s) and the disconnected grace (10 s) may be tuned from the hold-phase results without changing
  the approach.
