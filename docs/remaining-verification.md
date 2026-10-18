# Remaining verification guide

What the automated checks in this repository could not prove, and exactly how to prove it. Do these in order; each step
says what a pass and a failure mean. Background: [network-diagnostics.md](network-diagnostics.md),
[port-mapping.md](port-mapping.md), [testing.md](testing.md).

## What is already verified

- Unit and in-process end-to-end tests (`packages/sync`, `server`), including the early-candidate fix and the failure
  causes. Run: `pnpm --filter @hivetex/sync test`, `pnpm --filter @hivetex/server test`.
- Browser sync over real local WebRTC (`pnpm exec playwright test e2e/realtime.spec.ts e2e/presence.spec.ts e2e/sync-status.spec.ts e2e/network-diagnostics.spec.ts e2e/doorbell.spec.ts`).
- Not verified: real internet paths (different networks, NAT, TURN), the native desktop peer on a real machine, the
  router matrix, and everything that needs a relay.

## 1. Two real devices on different networks (the reported project)

Why: the original failure only appears when the two devices cannot reach each other directly.

1. Make sure the relay exists first (ExpressTURN account or Cloudflare; see `docs/deployment.md`), or the test cannot succeed behind strict NATs. In `TODO.md` follow *Turn on the
   TURN relay* (Cloudflare key, Vercel variables, redeploy). Check that the `turn` request in DevTools returns
   `turn:` or `turns:` URLs, and that **Network diagnostics > Connection servers** says *relay credentials issued*.
2. Update both devices to the same version that includes this change.
3. On each device: open the project, then **Sync > Network diagnostics**. Run the checks and note the result of each.
4. On one device press **Test connection** next to the other person. Wait up to 25 s.
5. Read the outcome:

| Result | Meaning | Next step |
|---|---|---|
| Connected, route *direct* | Direct path works | Done. |
| Connected, route *through the relay (TURN)* | Direct path impossible, relay works | Done; check the relay quota if usage is high. |
| *no setup reply* | The other device did not answer | Check it is online, has the same project open, and its signaling check passes. |
| *no candidates* | Setup arrived, candidates did not | Look at the connection trace (below); suspect signaling loss. |
| *checks failed* with relay unavailable | No path and no relay | Fix the relay (step 1). |
| *checks failed* with relay available | No path even with a relay | Run the relay check on both sides; a blocked relay port is likely. Try another network (phone hotspot). |

6. Click **Copy report** on both devices and keep them. If anything is still unexplained, add a task with the report
   attached and a test that reproduces it.

Pass criterion: both devices end up *Connected* within one minute without the user doing anything except opening the
project.

## 2. Playwright tests that need a relay

Skipped by default because they need services the dev server does not provide.

- TURN only (`e2e/relay-only.spec.ts`): needs only the local coturn (127.0.0.1:3478, user `dev` / `dev-stack-turn`); the
  dev server starts as usual. Docker is required.

  ```bash
  docker compose --profile turn up -d turn
  RELAY_ONLY=1 pnpm exec playwright test e2e/relay-only.spec.ts
  ```

  Pass: both browsers connect through TURN only, edit, drop the link and reconnect through TURN.
- Application relay (`e2e/application-relay*.spec.ts`, relay variant of `realtime.spec.ts`):
  `APPLICATION_RELAY=1 pnpm exec playwright test e2e/application-relay.spec.ts e2e/application-relay-recovery.spec.ts`.

On failure the test attaches `connection-trace-N.txt` per page (see "Reading a trace").

## 3. Desktop end-to-end (native peer, real window)

Why: the desktop app runs sync in a native worker with its own network stack; only a real build exercises it.

Prerequisites: Rust toolchain, Node 22, pnpm. Windows needs WebView2 and downloads `msedgedriver` automatically;
Linux needs the WebKitGTK packages listed in `.github/workflows/desktop.yml`.

```bash
make desktop-e2e                    # same as: pnpm --filter @hivetex/desktop e2e
```

Pass: all of `desktop.test.mjs`, `background.mjs`, `cpu.test.mjs`, `soak.test.mjs` pass. On failure the error message
ends with the connection trace of the open project. The same job runs in CI on `ubuntu-24.04` and `windows-2022`
(`desktop.yml`, job `desktop-e2e`); pushing a branch that touches `apps/desktop` runs it.

## 4. Router matrix (NAT types, UPnP, TURN)

Why: reproduces "symmetric NAT without a relay fails" and "UPnP makes a direct path work" with real network
namespaces. Needs Linux and root.

```bash
# Linux host, as root:
apps/desktop/e2e/netlab/run.sh

# any host with Docker (Windows/macOS included):
docker build -t hivetex-netlab apps/desktop/e2e/netlab
docker run --rm --privileged -v "$PWD:/src" -v hivetex-netlab-target:/target hivetex-netlab
```

The result is written to `$NETLAB_OUT` (default `/tmp/netlab-result.json`): selected candidate pair, mapping status
and packet counts per case. Pass: every case in the file reports its expected outcome (the matrix prints a summary and
exits non-zero otherwise). CI runs it as job *Router matrix* in `.github/workflows/desktop.yml` and uploads
`netlab-result.json` as the `router-matrix` artifact.

## 5. Native peer on a real machine

Build the installer to hand to the other machine with `make installer` (output in `dist-installer/`, `HiveTeX_<version>_x64-setup.exe`).

The probes in the Network diagnostics page run from the web view. To check the native stack itself, run the example
peer on two machines (`apps/desktop/src-tauri/examples/rtc_cli.rs`, built by `cargo build --example rtc_cli` in
`apps/desktop/src-tauri`) or, simpler, repeat section 1 with the desktop app on at least one side. The **Co-authors**
section of the page then shows the native link's candidate types and selected path.

## 6. Two machines on one PC: `make sandbox-sync` (Windows 11)

The desktop test build runs on this PC and inside Windows Sandbox (a VM behind its own NAT). The script registers an
account on each, shares a project (the sandbox joins as editor), checks a new file and an edit in each direction and
concurrent edits, runs *Test connection* on both sides at once, and writes everything to
`<E2E target>/sandbox-sync/<run>/`, by default `apps/desktop/src-tauri/target/e2e/sandbox-sync/<run>/` (`summary.json`, `timeline.txt` with both traces and the server's
signaling log merged by time, per-side diagnostics and logs). The sandbox window opens; the app installed on this PC is
not touched (the test build has its own identifier and credential store).

```
make sandbox-sync                                        # local server, STUN only, no application relay
set -a; . ./.env.setup; set +a; make sandbox-sync        # local server handing out the TURN relay, like production
NO_APP_RELAY=0 make sandbox-sync                         # the local server also offers the application relay
HOLD_S=300 make sandbox-sync                             # then keep editing for 5 minutes (an edit every 5 s, alternating
                                                         # sides, each within HOLD_MAX_MS=10000), route changes recorded
MATRIX=stun,turn,relay,relay-stun,deaf make sandbox-sync # one run per scenario and a table (TURN_* needed for turn/relay/deaf)
FAULT=deaf-silent make sandbox-sync                      # the production failure: a server session that stopped receiving
FAULT=deaf make sandbox-sync                             # the same, as the server now handles it (closes, client reconnects)
SERVER=https://hivetex.vercel.app make sandbox-sync      # against production (creates two test accounts and a project)
```

Results on 2026-10-13 (this PC behind a VPN, so both public addresses are the same): STUN only fails at
`checks-failed` (no direct path; the relay is needed, as between two symmetric NATs); with TURN, passes; against
production, passes; `deaf-silent` reproduces the reported pair (offers sent, never received, the far side never learns
the device); `deaf` recovers in under a second. Open: with TURN the first attempt sometimes ends at `checks-failed`
after 20 s and the second connects within 3 s.

## 7. WebRTC lab: `make rtc-lab` (Windows 11)

Same two machines, but no HiveTeX code between them: a minimal signaling server (`apps/desktop/e2e/rtclab/server.mjs`)
and on each side a WebRTC peer that connects, then exchanges a ping every second for `HOLD_S` seconds (default 45). It
separates the network and the relay from the WebRTC stack.

```
set -a; . ./.env.setup; set +a
make rtc-lab                         # browser peers (Chromium here, Edge in the sandbox): libwebrtc on both sides
PEERS=native make rtc-lab            # the desktop's Rust stack on both sides (rtc_cli, shared muxed listener)
PEERS=native-browser make rtc-lab    # native here, browser in the sandbox (also browser-native)
SCENARIOS=relay-udp,all make rtc-lab # a subset of relay-udp, relay-tcp, all, stun
```

A scenario passes when the offering side got at least 90 % of its pongs. `results.jsonl` holds every event of both
peers (candidates by type, connection and ICE states, the selected pair, the native stack's own log lines) and
`summary.json` a row per scenario. The native peer needs `cargo build --example rtc_cli` and one build of the desktop
test app (for its Node runtime).

Results on 2026-10-13, same TURN account: browser ↔ browser passes all four scenarios (relay-only UDP and TCP in about
190 ms, direct in under 20 ms, 44/45 pongs each); native ↔ native passes relay-only over UDP only (TCP TURN is not
supported by webrtc-rs; with all candidates or STUN only, ICE ends `failed` after 25 s); native ↔ browser passes
relay-only UDP, all candidates and STUN only. See [decisions/native-webrtc.md](decisions/native-webrtc.md).

## Reading a trace

Every connection step is recorded per peer, without credentials, keys, addresses or content:

```
+    4 ms  a-device -> z-device     attempt.start role=offerer
+    5 ms  a-device -> z-device     link.offer.sent
+    8 ms  z-device -> a-device     sig.held k=ice held=1          <- candidate arrived before the offer, kept
+   55 ms  z-device -> a-device     sig.applied-held count=1
+   58 ms  a-device -> z-device     link.answer.received
+   58 ms  a-device -> z-device     link.up
```

- Unit and server tests print it on failure. In your own test pass `trace: traceLog().sink` to the manager.
- Playwright: `connection-trace-N.txt` attachment (HTML report or `test-results/`).
- Desktop WebDriver: appended to the failure message.
- Running app with `localStorage['hivetex.test']='1'`: `__p2p.session.syncDiagnostics().trace` in the console.

Where it stopped tells you the layer: no `sig.recv` on the far side means signaling; `sig.recv` but no `link.created`
means configuration (`ice.timeout` or `ice.error`); `link.offer.sent` and `link.answer.received` followed by
`link.timeout cause=checks-failed` means the network path (look at `link.ice.local` / `link.ice.remote` types:
only `host` on both sides across networks means no STUN result and no relay).

## Checklist

- [ ] Relay enabled in production and visible in the page (section 1, step 1)
- [ ] Two real devices connect (section 1)
- [ ] Relay Playwright specs pass (section 2)
- [ ] `make desktop-e2e` passes on Windows and Linux (section 3)
- [ ] Router matrix passes (section 4)
- [ ] Desktop app tested as one side of a real pair (section 5)
- [x] Two machines on one PC, local server with TURN, against production, and the deaf-session fault (section 6)
- [ ] First TURN attempt sometimes times out at `checks-failed` before the second connects (section 6)
