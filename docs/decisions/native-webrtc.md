# Decision record: the desktop's native WebRTC stack

Status: **keep webrtc-rs 0.13 behind the relay-first transport; do not replace it now.** Revisit with the criteria
below when the relay cost or a real-network report says the direct path matters more.

## Context

The desktop app's sync worker has no `RTCPeerConnection`, so its WebRTC goes through the Rust crate `webrtc` 0.13
(webrtc-rs, with a vendored `webrtc-ice` for the shared UDP listener; `src-tauri/src/rtc.rs`). Two members could not
sync although signaling worked. The question was whether the network, the TURN provider or the stack was at fault, and
whether another approach (another stack, WireGuard, a relay) should replace it.

## Evidence (2026-10-13, one lab, one TURN account)

The lab: this PC behind a WireGuard VPN (NordLynx), Windows Sandbox behind Hyper-V NAT, ExpressTURN (UDP and TCP
3478). `make rtc-lab` runs the same four scenarios with each pair of stacks; a scenario passes with at least 40 of 45
pings answered.

| Stacks | relay only, TURN UDP | relay only, TURN TCP | all candidates | STUN only |
|---|---|---|---|---|
| browser ↔ browser (libwebrtc) | pass, ~190 ms, relay↔relay | pass, ~190 ms | pass, direct in < 20 ms | pass, direct |
| native ↔ native (webrtc-rs) | pass, ~2.2 s, relay↔relay | fail: no TCP TURN | **fail**: ICE `failed` after 25 s | **fail**: ICE `failed` after 25 s |
| native ↔ browser | pass, relay↔relay | fail: no TCP TURN on the native side | pass, direct (host↔prflx) | pass, direct |

With HiveTeX itself (`make sandbox-sync`): native↔native with TURN mostly ended at `checks-failed` after 20 s; links
that did connect were direct `srflx↔host` pairs that went `disconnected` 5 s later and never failed over to the relay
pair; against production no sync in 4 minutes. With the application relay the same apps synced in 9 s (STUN only) and
21 s (with TURN, when the relay still waited for the first attempt); relay-first now syncs within a few seconds.

What the code and upstream say about webrtc-rs:
- TURN over UDP only: `turn:...?transport=tcp` and `turns:` URLs are skipped (`agent_gather.rs`; upstream #539 closed
  "not planned", #848 open on the 0.20 rewrite). On networks that block UDP the desktop has no relay at all.
- No switch to another candidate pair once the selected one dies (pion/ice lineage; renomination only recently in
  pion v4): a dead pair means `disconnected` (5 s), then `failed`, then a new attempt.
- Every interface gathers host candidates: eleven on this PC (VPN, Hyper-V, WSL, Wi-Fi Direct adapters). Chromium
  gathers only the default-route address. Native↔native fails with all candidates but passes relay-only and passes
  against a browser, which points at the native side's pair handling with many candidates.
- Until this change its own log went nowhere (no logger), so failures could not be explained.

## Options considered

| Option | Connectivity | TURN TCP/TLS | Pair failover | Platforms | Effort / risk |
|---|---|---|---|---|---|
| Keep webrtc-rs 0.13 + relay first (this change) | relay guarantees sync; direct when it works | no | no | all | done; native direct path stays weaker than browsers |
| webrtc-rs 0.20 (sans-I/O rewrite) | adds ICE-TCP | no (#848) | not documented | all | rewrite of the bridge; browser interop "tested by hand" upstream |
| The webview's own WebRTC (WebView2 / WKWebView = libwebrtc) | browser-grade, as measured above | yes | yes (continual gathering) | Windows, macOS; WebKitGTK uncertain | sync must run where a webview exists: the background worker has none |
| libdatachannel (C++, libjuice/libnice) | good; TURN TCP/TLS only with libnice, for control only | partial | limited | all | native build and bindings |
| iroh 1.x (QUIC, own HTTPS relay) | relay over HTTPS 443 + hole punching | n/a (relay is HTTPS) | yes (multipath) | native; browsers relay-only via WASM | a second transport next to WebRTC for browsers; new relay servers |
| WireGuard / tsnet | still needs NAT traversal and a relay | n/a | n/a | not in browsers; driver or userspace netstack | no gain over a relay |

## Decision

1. The application relay is the guarantee (relay first, direct after an 8 s probation, hand-back on disconnect). It
   is the only measured path that worked in every scenario, and it works from browsers and through UDP-blocking
   networks because it rides the signaling WebSocket.
2. Keep webrtc-rs for the direct upgrade, with the visibility added here (its own log, ICE state, selected pair,
   relay-only test, explicit timeouts).
3. Do not adopt WireGuard.
4. Revisit a replacement when one of these holds: the relay's measured cost exceeds the deployment budget; real
   reports show long relay-only sessions between members whose browsers connect directly; or the background worker
   can host a webview-backed peer. The first candidate to prototype is the webview's own WebRTC for the foreground
   app (libwebrtc, measured above), then iroh if a non-WebRTC path is wanted.

## Interface filtering spike

Measured with `NATIVE_INTERFACES=default|physical make rtc-lab` (native ↔ native, scenarios `all` and `stun`). The
filter would be adopted only if it turned failing scenarios into passes without removing a working path.

| Native ↔ native | all candidates | STUN only |
|---|---|---|
| every interface (default) | fail: `failed` at 25 s | fail |
| `default`: default-route address only (as Chromium) | fail: connected at 3.4 s, `disconnected` 5 s later, `failed` at 28 s | fail |
| `physical`: virtual adapters excluded | fail | fail |

**Not adopted.** Fewer candidates do not fix it: with the default route only, the stack connects and then loses the
path after the 5 s consent window, the same drop seen in the app; relay-only keeps working. The option stays in the
bridge for measurements (`interfaces` in `rtc_create`, `NATIVE_INTERFACES` in the lab; the app uses every interface).

What was adopted instead: after an attempt whose checks failed, every other attempt is relay-only when TURN is
configured (`link.policy` with `after=checks-failed` in the trace). Native relay-only connected in every run (about
2 s), and a TURN route spends no application-relay budget.

## Long TURN sessions (2026-10-14)

The 45 s lab holds above hid a second fault: every native TURN route died about four minutes after it was set up
(`make rtc-lab PEERS=native SCENARIOS=relay-udp HOLD_S=330`: `disconnected` at 243 s; the same in two `make
sandbox-sync` runs and in a field report). Browser peers held the same server for 330 s. ExpressTURN grants 240 s
allocations and lets channel bindings lapse with them; webrtc-rs's TURN client refreshes a binding only after 5 minutes.
It also refreshed permissions in one request listing every peer address, which ExpressTURN refuses (400), and repeated
successful refreshes three times. The desktop now uses a patched `turn` 0.10.0 (`apps/desktop/src-tauri/vendor/PATCHES.md`):
bindings refreshed every 2 minutes, one CreatePermission per address. The same 330 s lab hold passes (327/330 pongs); with
only the binding interval undone it dies again at 244 s. When the route still drops, the application relay takes over
(see protocol.md, Hand-back).
