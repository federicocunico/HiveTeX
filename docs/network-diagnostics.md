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

Under *Co-authors* each person shows the connection state, the stage the last attempt reached, the candidate types
gathered here and received from them, and the selected network path once connected. **Test connection** retries now
and reports the route, or the stage and cause of the failure:

| Cause | Meaning |
|---|---|
| no setup reply | The other device never answered. It may be offline or unable to reach signaling. |
| no candidates | Setup was exchanged but no network candidates arrived from the other device. |
| checks failed | Addresses were exchanged and no path worked. A relay is usually needed. |

**Copy report** puts the results on the clipboard for sharing. It contains no passwords, tokens, keys, relay
credentials or public addresses.

The STUN and relay probes run from the page's own network stack. On desktop that is the web view, not the native
peer-to-peer stack, so a desktop result for a peer is the *Co-authors* section, not the probes.

## Connection trace

The connection layer records every step towards each peer (configuration, attempts, setup messages sent, received and
held, candidates, link state, retries, causes). The trace never contains credentials, keys, addresses or content.

- Unit and server end-to-end tests record the trace of every participant and print it when a test fails
  (`TraceLog` in `@hivetex/sync/testing`; pass `trace: traceLog().sink` to a manager).
- Playwright specs import `test` from `e2e/trace-fixture.ts`, which attaches `connection-trace-N.txt` per page when a
  test fails.
- Desktop WebDriver failures append the trace to the error message (`Session.connectionTrace()`).
- In a running app with `hivetex.test` set, `__p2p.session.syncDiagnostics().trace` returns the latest 500 steps.
