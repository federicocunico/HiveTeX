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

**Test connection** (up to about 30 s) checks the path to one co-author stage by stage and says which stage failed:

| Step | Pass means | Failure means |
|---|---|---|
| This device and the signaling service | This device is connected to the service. | Setup messages can only go through another connected co-author. |
| Co-author device known | This device holds a valid ticket of theirs, and whether it sees them on the service. | They are offline for this device, or their ticket was rejected (`device.rejected` in the trace). |
| Setup message sent | A test message left, sealed like an offer, over the service (or through a co-author). | It could not leave: the reason is given. |
| Accepted by the service | The service (0.7.2 or later) acknowledged it, and said whether the co-author is connected. | No acknowledgement: an older service, or the message was lost before the service. |
| Delivered to the other device | The service handed it to the co-author's connection. | Accepted but not delivered: a problem inside the service. |
| Answer from the other device | Their app answered with its own state: app version, signaling, whether it knows this device, its role, its attempts and last cause, its connection servers and relay. Their offering side also retries at once. | Delivered but no answer: they run an app older than 0.7.2, or their app drops this device's messages (their report says why). |
| Connection | A fresh WebRTC attempt connected; the route (direct, TURN relay, application relay) and selected candidate pair. | The stage it stopped at: no setup reply, no candidates, checks failed, or an error. |

The test ends with a one-sentence verdict. *Test details* shows the full test as text, including every connection
step towards that co-author during the test; **Copy this test** copies it.

## Report

**Copy report** puts on the clipboard: app and version, OS and browser engine, this device (short id, signaling
state, counters of connections and setup messages), the checks, the connection servers, every co-author's state, every
connection test run on the page, and the latest 400 connection steps. Device ids are shortened to 8 characters. It
contains no passwords, tokens, keys, relay credentials, public addresses or document content.

To diagnose a pair, run *Test connection* on both devices at about the same time and send both reports.

## Connection trace

The connection layer records every step towards each peer. The trace never contains credentials, keys, addresses or
content. **Show connection trace** on the page shows the latest 200 steps live.

| Event | Meaning |
|---|---|
| `manager.start`, `manager.stop` | Networking for the project started (with the app version) or stopped. |
| `socket.opening`, `socket.opened`, `socket.challenge`, `server.ready`, `socket.closed` | The signaling connection: opening, open, authenticating, accepted (how many other devices are on the service, the session id), closed (the retry delay, and `reopen=true` when it reconnects because a device is still being connected; `reason=idle` when this device closed it because nothing needs it). On desktop the socket opens on demand: it stays open while a device seen on the service is not yet connected. |
| `server.err` | The service refused something; `code` says what (for example an expired ticket). `subscription_lost`: the service stopped receiving messages for this device and closed the connection so that it reconnects (before, such a device stayed listed online but received nothing). |
| `device.learned` | A co-author device became known, from the service or from a peer, with this device's role towards it (offerer: lower device id). |
| `device.rejected` | A device's ticket was not accepted; `reason` says why. |
| `peer.join`, `peer.leave` | A co-author connected to or left the service. |
| `attempt.start`, `attempt.wait`, `attempt.retry-now` | This device starts an offer, waits for the other device's offer (answerer), or retries at once (connection test). |
| `ice.request`, `ice.ok`, `ice.cached`, `ice.timeout`, `ice.error` | Connection servers requested, received (count and relay status), reused, or not obtained. |
| `link.created`, `link.offer.sent`, `link.offer.received`, `link.answer.sent`, `link.answer.received` | The WebRTC link and its offer/answer exchange. |
| `link.ice.local`, `link.ice.remote` | A network candidate gathered here or received (type only: host, srflx, relay). |
| `link.state` | Connection and ICE state changes. |
| `link.channels.open`, `link.route`, `link.up` | The data channels opened, the selected pair's candidate types, the link handed to sync. |
| `mesh.auth-ok`, `mesh.auth-failed` | The peers proved their membership over the new link, or that check failed (with the error). |
| `link.lost`, `peer.lost` | A connected link stopped carrying data (`state`: failed, or disconnected for more than 10 s) and was ended; the device left the mesh, and on-demand signaling reopens to connect it again. |
| `link.timeout`, `link.failed`, `link.abandoned` | An attempt ended without a link, with the stage it reached (`cause`). |
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

Where the trace is collected:

- `make sandbox-sync` (Windows 11) runs the desktop test build on this PC and in Windows Sandbox, has them share a project
  and edit it, and writes both traces and the server's signaling log merged by time to
  `apps/desktop/src-tauri/target/sandbox-sync/<run>/timeline.txt` (see the script header for the server, TURN and fault options).

- Unit and server end-to-end tests record the trace of every participant and print it when a test fails
  (`TraceLog` in `@hivetex/sync/testing`; pass `trace: traceLog().sink` to a manager).
- Playwright specs import `test` from `e2e/trace-fixture.ts`, which attaches `connection-trace-N.txt` per page when a
  test fails.
- Desktop WebDriver failures append the trace to the error message (`Session.connectionTrace()`).
- In a running app with `hivetex.test` set, `__p2p.session.syncDiagnostics().trace` returns the latest 1500 steps.
