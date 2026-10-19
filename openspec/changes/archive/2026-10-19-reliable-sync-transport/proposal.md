# Proposal

## Why

Two members of one project still cannot sync, although signaling now works end to end (server acknowledgement and
delivery receipts in about 300 ms against production). Measurements on 2026-10-13, all in one lab (this PC behind a
WireGuard VPN, Windows Sandbox behind Hyper-V NAT, the same ExpressTURN account, the same signaling):

| Same lab, same relay | Result |
|---|---|
| Chromium ↔ Edge (libwebrtc), relay only, TURN over UDP | connected in 190 ms, relay ↔ relay, stable for 45 s |
| Chromium ↔ Edge, relay only, TURN over TCP | connected in 190 ms, stable |
| Chromium ↔ Edge, all candidates / STUN only | connected directly in under 20 ms, stable |
| HiveTeX desktop ↔ desktop (webrtc-rs 0.13), with TURN | `checks-failed` after 20 s in most attempts; when a pair connects it goes `disconnected` 5 s later; relay pairs never take over; against production, no sync in 4 minutes |
| HiveTeX desktop ↔ desktop with the existing application relay (off in production) | sync in 9 s (STUN only) and 21 s (with TURN) |

So the network and the TURN provider are not the problem: the native WebRTC stack is. That matches what is documented
for webrtc-rs (TURN over TCP/TLS unsupported in both the 0.13 line we vendor and the 0.20 rewrite; no switch to another
candidate pair once the selected one dies; 5 s disconnected timeout) and what production peer-to-peer systems do
(Tailscale, iroh, Syncthing, Yjs servers): an always-reachable relay over TCP/443 carries the session first, direct
paths are an upgrade. WireGuard is not a fit: it needs a driver or a userspace network stack, does not run in a browser,
and still needs the same NAT traversal and relay.

## What Changes

- The application relay becomes the guaranteed path instead of the last resort: two members who both reach the server
  sync through it within seconds, and WebRTC (direct or TURN) is attempted in the background and used only once it has
  proven to carry traffic. A direct link that stops answering hands back to the relay at once.
- The application relay is enabled in production, with budgets derived from measured usage and the relay cost visible
  in the deployment documentation.
- The native WebRTC stack gets the minimum hardening and visibility the investigation showed was missing: its internal
  ICE/TURN log reaches the diagnostics, ICE state is reported, attempts no longer time out before the stack's own
  failure timeout, and the connection test can force a relay-only attempt on the desktop as in the browser.
- A repeatable lab (`make rtc-lab`) compares the browser's WebRTC with the native stack on the same machines, next to
  `make sandbox-sync`; both are the acceptance tests for this change.
- A decision record evaluates replacing the native stack (the webview's own WebRTC where available, iroh 1.x, webrtc-rs
  0.20) with criteria; no replacement is implemented here.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `peer-sync`: transport selection becomes relay-first with direct upgrade (Safe transport selection, NAT traversal
  fallback); a direct link that goes silent falls back to the relay without waiting for a failure; the control-plane
  socket may stay open while a relay link is the route (Zero idle control-plane cost); native connection attempts are
  bounded by the stack's own failure timeout.
- `network-diagnostics`: reports include the native connection stack's own log lines and ICE state, and the peer test
  can force a relay-only attempt on the desktop.

## Impact

- `packages/sync` (connection manager: route selection, relay start, promotion and demotion, attempt deadlines),
  `apps/desktop/src-tauri` (rtc bridge: logger, ICE state events, transport policy, timeouts), `apps/web` (route text,
  report), `server` (relay enabled in production; limits), `docs/deployment.md`, `docs/protocol.md`.
- Production cost: relayed traffic goes through Vercel functions and Upstash pub/sub (about 5 Upstash commands per
  relayed frame) until a direct path takes over; budgets must be set from measurements (`USAGE_LOG=1`).
- Out of scope: replacing the native WebRTC stack, self-hosted relay servers, TURN over TLS on 443 for the desktop
  (impossible with webrtc-rs today).
