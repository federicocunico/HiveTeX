# Network diagnostics

When two members cannot sync, open **Network diagnostics**: in a project from *Sync > Network diagnostics* (or the
command palette), or outside a project from *Account and preferences*. It runs these checks and says what each result
means:

| Check | What it tells you |
|---|---|
| Signaling service | This device is connected to the service that lets devices find each other. Idle means it opens on demand. |
| Connection servers | Which STUN servers were offered and whether relay (TURN) credentials were issued. If not, the page says why: *not configured* or *could not issue credentials*. |
| UDP and public address | Whether STUN answers (UDP works) and whether the router keeps the same port for different destinations. Different ports (symmetric NAT) usually need a relay. |
| Relay (TURN) | Whether the relay answers from this network. |
| Router port mapping | Desktop only: the UPnP state. A mapping is an offer to peers, never a connection. |

Under *Co-authors* each person shows the connection state, whether they are seen on the signaling service, the stage
the last attempt reached, the candidate types gathered here and received from them, the last error, and the selected
network path once connected.

The STUN and relay probes run from the page's own network stack. On desktop that is the web view, not the native
peer-to-peer stack, so a desktop result for a peer is the *Co-authors* section and the connection test, not the probes.

## Test connection

**Test connection** (up to about 45 s) checks the path to one co-author stage by stage and says which stage failed.
**Test relay only** runs the same test with its WebRTC attempt restricted to relay (TURN) candidates on this device,
also on the desktop's native stack: it shows whether the TURN path works on its own and over which transport (`TURN
over udp` / `tcp`). When the co-author is already linked directly the variant says so and makes no attempt; while the
application relay is the route it makes a TURN attempt next to it.

| Step | Pass means | Failure means |
|---|---|---|
| This device and the signaling service | This device is connected to the service (on the desktop it is opened for the test when it was closed on demand). | Setup messages can only go through another connected co-author. |
| Co-author device known | This device holds a valid ticket of theirs, and whether it sees them on the service. | They are offline for this device, or their ticket was rejected (`device.rejected` in the trace). |
| Setup message sent | A test message left, sealed like an offer, over the service (or through a co-author). | It could not leave: the reason is given. |
| Accepted by the service | The service (0.7.2 or later) acknowledged it, and said whether the co-author is connected. | No acknowledgement: an older service, or the message was lost before the service. |
| Delivered to the other device | The service handed it to the co-author's connection. | Accepted but not delivered: a problem inside the service. |
| Answer from the other device | Their app answered with its own state: app version, signaling, whether it knows this device, its role, its attempts and last cause, its connection servers and relay. Their offering side also retries at once. | Delivered but no answer: they run an app older than 0.7.2, or their app drops this device's messages (their report says why). |
| Application relay | The application relay is the route and an encrypted test frame went to the other device and back through the HiveTeX server (round trip in ms). Informational when it is not the route: available, not offered by the service, or not offered by the other device. | It is the route but the frame did not come back within 5 s: an older app on the other side, or relayed frames are being lost. |
| Connection | A fresh WebRTC attempt connected; the route (direct, TURN relay, application relay), the selected candidate pair and, for a relay pair, the transport to the TURN server. | The stage it stopped at: no setup reply, no candidates, checks failed, or an error. |

The test ends with a one-sentence verdict. *Test details* shows the full test as text, including every connection
step towards that co-author during the test and, on the desktop, the native stack's own log lines written meanwhile;
**Copy this test** copies it.

## Report

**Copy report** puts on the clipboard: app and version, OS and browser engine, this device (short id, signaling
state, counters of connections and setup messages), the checks, the connection servers, every co-author's state
(its ICE state on the desktop), every connection test run on the page, on the desktop the native connection stack's
latest 80 log lines (*Native connection stack*, addresses masked; see below), and the latest 400 connection steps.
Device ids are shortened to 8 characters. It contains no passwords, tokens, keys, relay credentials, public addresses
or document content.

To diagnose a pair, run *Test connection* on both devices at about the same time and send both reports.

## Connection trace

The connection layer records every step towards each peer. The trace never contains credentials, keys, addresses or
content. **Show connection trace** on the page shows the latest 200 steps live.

| Event | Meaning |
|---|---|
| `manager.start`, `manager.stop` | Networking for the project started (with the app version) or stopped. |
| `socket.opening`, `socket.opened`, `socket.challenge`, `server.ready`, `socket.closed` | The signaling connection: opening, open, authenticating, accepted (how many other devices are on the service, the session id), closed (the close `code` and `reason` from the service, e.g. 4401, 1012; the retry delay; `reopen=true` when it reconnects because a device is still being connected; `reason=idle` when this device closed it because nothing needs it). On desktop the socket opens on demand: it stays open while a device seen on the service is not yet connected, while the application relay is a route, and while a direct route is degraded. |
| `socket.silent` | The service did not answer a ping within 10 s: the connection is treated as lost (`socket.closed code=4000`) and reopened. A path dropped without a close (a NAT, proxy or VPN) would otherwise leave this device listed but deaf. |
| `server.err` | The service refused something; `code` says what (for example an expired ticket). `subscription_lost`: the service stopped receiving messages for this device and closed the connection so that it reconnects (before, such a device stayed listed online but received nothing). |
| `device.learned` | A co-author device became known, from the service or from a peer, with this device's role towards it (offerer: lower device id). |
| `device.rejected` | A device's ticket was not accepted; `reason` says why. |
| `peer.join`, `peer.leave` | A co-author connected to or left the service. |
| `attempt.start`, `attempt.wait`, `attempt.retry-now` | This device starts an offer, waits for the other device's offer (answerer), or retries at once (connection test). |
| `ice.request`, `ice.ok`, `ice.cached`, `ice.timeout`, `ice.error` | Connection servers requested, received (count and relay status), reused, or not obtained. |
| `link.created`, `link.offer.sent`, `link.offer.received`, `link.answer.sent`, `link.answer.received` | The WebRTC link and its offer/answer exchange. |
| `link.ice.local`, `link.ice.remote` | A network candidate gathered here or received (type only: host, srflx, relay). |
| `link.state` | Connection and ICE state changes. |
| `link.ice-state` | The ICE agent's own state where the stack reports it (the desktop's native stack): `checking`, `connected`, `disconnected` (no answers for 5 s), `failed` (no working pair after 20 s). |
| `link.pair` | The candidate pair the native stack selected or switched to: local and remote type, protocol. No addresses. |
| `link.channels.open`, `link.route`, `link.up` | The data channels opened, the selected pair's candidate types, the link handed to sync. |
| `link.probation`, `link.probation-ok`, `link.probation-failed` | The link came up while the application relay was the route (or was still being set up): it must stay connected for 8 s before it replaces the relay; failed means it dropped meanwhile (edits stayed on the relay). |
| `link.degraded` | The direct route reported disconnected: the relay is started at once (and, on desktop, the other device is rung so it comes to the service) while the link gets its 10 s grace. `by=peer`: the other device reported its side of the link silent while it still looks fine here. |
| `mesh.auth-ok`, `mesh.auth-failed` | The peers proved their membership over the new link, or that check failed (with the error). |
| `link.lost`, `peer.lost` | A connected link stopped carrying data (`state`: failed, or disconnected for more than 10 s) and was ended; the device left the mesh, and on-demand signaling reopens to connect it again. |
| `link.timeout`, `link.failed`, `link.abandoned` | An attempt ended without a link, with the stage it reached (`cause`). |
| `link.signal.error` | Applying a setup message failed in the WebRTC stack (the message text says why); the attempt ends. |
| `retry.scheduled` | The next attempt and its delay. |
| `sig.send` | A setup message left: kind, path (service or a co-author), whether the target is seen on the service. |
| `sig.server-ack`, `sig.delivered` | The service accepted it (and whether the target is connected), then delivered it. |
| `sig.no-server-ack`, `sig.not-delivered` | No acknowledgement within 4 s, or no delivery within 6 s. |
| `sig.unsent` | It could not be sent, and why. |
| `sig.recv`, `sig.held`, `sig.applied-held` | A setup message arrived; candidates that arrived before their link were kept, then applied. |
| `sig.dropped` | An arriving message was discarded: its sender's ticket was rejected, or it could not be decrypted. |
| `sig.forwarded`, `sig.forward-dropped` | A message for another device was passed on through this device, or could not be. |
| `probe.*` | A connection test: started, received (and whether it asked for a retry), replied, ended with its verdict. |
| `relay.start` | Setup of the application relay started. |

### The native stack's own log

On the desktop, the WebRTC stack itself (`webrtc`, `webrtc_ice`, `turn` ...) logs at info and warning level into a
bounded ring of 600 lines in the app process (`src-tauri/src/rtc_log.rs`): candidate gathering, TURN allocation and
permission errors, pair checks that failed, consent timeouts. Before a line is kept, IP addresses become `<ip>` and any
line mentioning a username, password, credential, realm, nonce or message integrity is dropped. The worker reads it
with the `rtc_log` native call (`since` = the last sequence number it saw); `rtc_cli` answers the same command.

Where the trace is collected:

- `make sandbox-sync` (Windows 11) runs the desktop test build on this PC and in Windows Sandbox, has them share a project
  and edit it (optionally for minutes: `HOLD_S`; or a scenario matrix: `MATRIX`), and writes both traces and the
  server's signaling log merged by time to `<SANDBOX_OUT>/<run>/timeline.txt` (default `apps/desktop/src-tauri/target/e2e/sandbox-sync`; see docs/testing.md and the
  script header for the server, TURN and fault options).
- `make rtc-lab` (Windows 11) compares WebRTC stacks on the same two machines without HiveTeX code: browser and/or
  native peers, relay-only and direct scenarios, pings for `HOLD_S` seconds; results in
  `apps/desktop/src-tauri/target/rtclab/<run>/` ([remaining-verification.md](remaining-verification.md#7-webrtc-lab-make-rtc-lab-windows-11)).

- Unit and server end-to-end tests record the trace of every participant and print it when a test fails
  (`TraceLog` in `@hivetex/sync/testing`; pass `trace: traceLog().sink` to a manager).
- Playwright specs import `test` from `e2e/trace-fixture.ts`, which attaches `connection-trace-N.txt` per page when a
  test fails.
- Desktop WebDriver failures append the trace to the error message (`Session.connectionTrace()`).
- In a running app with `hivetex.test` set, `__p2p.session.syncDiagnostics().trace` returns the latest 1500 steps.
