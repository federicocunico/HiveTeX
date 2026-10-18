# Tasks

## 1. Lab tooling (acceptance harness first)

- [x] 1.1 Move the browser-vs-browser WebRTC lab (signaling server, test page, Windows Sandbox runner) into `apps/desktop/e2e/rtclab` with a `make rtc-lab` target; verify it reproduces the 2026-10-13 browser results (relay-only UDP and TCP, all, STUN-only connect and answer ≥ 40/45 pings) and writes a results file
- [x] 1.2 Add the native peer to `make rtc-lab` (desktop test build driven over DevTools, bridge peer with a forced transport policy); verify the same four scenarios run native↔native and native↔browser and the results file names the selected pair and the native stack state per scenario
- [x] 1.3 Add a hold phase to `make sandbox-sync` (`HOLD_S`: periodic edits on both sides, convergence checked every few seconds, route changes logged) and a scenario matrix option (STUN only, TURN, relay on/off, deaf session); verify a 3-minute hold run on today's build reproduces the direct link dying after ~5 s in the timeline
- [x] 1.4 Document both labs in `docs/remaining-verification.md` and `docs/network-diagnostics.md`; verify the documented commands run as written

## 2. Native stack visibility and bounds

- [x] 2.1 Add a bounded in-process logger for `webrtc_ice`, `webrtc` and `turn` records (info/warn, IP addresses masked, records carrying TURN credentials dropped) exposed to the worker; verify a Rust unit test logs a TURN request and finds neither username nor credential nor an IP address in the buffer
- [x] 2.2 Forward ICE connection state and selected-pair changes as bridge events and record them in the connection trace (`link.ice-state`, `link.pair`); verify with a `rtc_cli` run and a sync unit test that the events reach the trace
- [x] 2.3 Forward `iceTransportPolicy` to the native peer and set explicit ICE timeouts (disconnected 5 s, failed 20 s, keepalive 2 s); verify `rtc_cli` with policy relay gathers only relay candidates and that a native attempt is never abandoned before the stack's failure timeout (client link timeout 30 s, unit test on the option)
- [x] 2.4 Update `docs/network-diagnostics.md` (trace glossary, native log section); verify the glossary lists every new event name
- [x] 2.5 (requested by the user) Ask the firewall question at launch: bind the shared UDP listener when the app starts (not at the first peer connection) and release it after 10 s; verify on Windows that a fresh build path prompts at launch, and that the installed app asks once
- [x] 2.7 (found in the 5-minute hold, root cause of the frozen sandbox) The desktop app writes to the sync worker's stdin from a thread of its own instead of under the supervisor lock: a full pipe no longer blocks the frame reader, which deadlocked the worker in long relay sessions (a burst of WebRTC setup events both ways); verify the Rust regression test (a worker that stops reading keeps delivering its frames, sends never block) and a 5-minute `relay-stun` hold in `make sandbox-sync`
- [x] 2.6 (found in the 5-minute hold) A signaling socket that does not answer a ping within 10 s is treated as lost and reopened (`socket.silent`), so a path dropped without a close cannot leave a device listed but deaf; verify the lifecycle test (silent server → reopened, code 4000) and that the existing heartbeat tests still pass

## 3. Relay first, direct as an upgrade

- [x] 3.1 Start the application relay as soon as both peers are seen and relay-capable (no 8 s delay, no TURN gate); verify a connection-manager test where WebRTC never connects syncs through the relay within 5 s of learning the peer
- [x] 3.2 Probation for direct links while a relay route exists (pings both ways over the data channel for 8 s before mesh handover; immediate use when no relay route exists); verify tests: a link that dies at 5 s never becomes the route, a healthy link takes over after probation without lost or duplicated edits
- [x] 3.3 Hand back to the relay at once when the route link reports disconnected or stops answering pings, while the 10 s link grace runs; verify a test where the direct route dies mid-session and edits arrive through the relay within 2 s
- [x] 3.4 Keep the signaling socket while a relay route is in use and close it once every wanted link is a direct route (zero idle unchanged otherwise); verify the lifecycle tests for both cases and the existing zero-idle tests
- [x] 3.5 Update `docs/protocol.md` (route order, probation, hand-back) and the route texts in the UI; verify `apps/web` route tests and the documented order
- [x] 3.6 (added after the lab, agreed with the user) With TURN configured, every other attempt after failed checks is relay-only, so a TURN route replaces the application relay instead of spending its budget; verify the connect-probe test (relay-only alternation with TURN, never without)

## 4. Diagnostics

- [x] 4.1 Include the native stack log and per-peer ICE state in *Copy report* and in the connection test details; verify netdiag unit tests that the section appears, is bounded and contains no credential or unmasked address
- [x] 4.2 Relay-only variant of *Test connection* (all platforms) and an application relay round-trip step; verify `connect-probe` tests for both and the Playwright network-diagnostics spec
- [x] 4.3 Document the new report sections and test variants in `docs/network-diagnostics.md`; verify against the rendered page

## 5. Interface filtering spike

- [x] 5.1 Measure in `make rtc-lab` native success with and without filtering virtual adapters (VPN, Hyper-V vEthernet, WSL) and adopt the filter only if it improves success without removing a working path; verify by the recorded results in `docs/decisions/native-webrtc.md`

## 6. Production relay

- [ ] 6.1 Measure baseline and relay command usage (`USAGE_LOG=1` in production, relay runs of `make sandbox-sync` against a preview) and compute `RELAY_PROVIDER_COMMANDS`, `RELAY_BASELINE_COMMANDS` and per-account limits; verify `relayLimitsFromEnv` accepts the profile and the numbers are recorded in `docs/deployment.md`
- [x] 6.2 Add the relay variables to `scripts/setup.mjs` prompts (values never printed) and deploy with a commit authored by the Vercel team member's address; verify `/api/health` and that a fresh session's `ready` advertises the relay capability
- [x] 6.3 Document cost per relayed MiB and per relay hour, the rollback (unset `RELAY_PROVIDER_COMMANDS`) and the gates from `docs/application-relay-security.md`; verify the deployment doc lists each

## 7. Native stack decision record

- [x] 7.1 Write `docs/decisions/native-webrtc.md` comparing the webview's WebRTC, iroh 1.x, webrtc-rs 0.20 and libdatachannel against the criteria in design.md, with `make rtc-lab` numbers where a prototype is cheap; verify the record states a recommendation and the evidence for it

## 8. Integration

- [ ] 8.1 Run the `make sandbox-sync` matrix locally (STUN only, TURN, relay on, deaf session) with a 5-minute hold; verify every scenario passes, sync starts within 5 s and continues across a socket rotation. Evidence: `../fix-data-safety-apply-regressions/evidence/matrix.md` (Windows Sandbox and host on one PC, Hyper-V NAT, not real NATs; STUN-only fails with checks-failed on this setup, every relay/TURN scenario passes; open because STUN-only does not pass on this setup).
- [x] 8.2 Run `make sandbox-sync` against production with a 5-minute hold; verify it passes and the timeline shows relay first and, when a direct link survives probation, the handover
- [x] 8.3 Two-PC test with the new installer (`make installer`) on two different networks; verify both reports show sync within 5 s and the route used

## Workflow follow-up

- Archive the change after the integration results are reviewed.
