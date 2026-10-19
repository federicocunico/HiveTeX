# Writing tests that pass on CI as well as locally

Native bridge suites rebuild `rtc_cli` and `tex_cli` before running an existing executable. A stale binary is never
used. They also build the current worker and prepare pinned Node resources when absent (the first preparation needs
network access; cached resources are reused offline). `CARGO_TARGET_DIR` is respected. On a clean checkout, run with
`HIVETEX_NATIVE_TESTS=1` to require Cargo, build both bridges, and require a
working TeX compiler (the Desktop CI job installs TinyTeX). In PowerShell:

```powershell
$env:HIVETEX_NATIVE_TESTS = '1'
pnpm --filter @hivetex/sync exec vitest run test/tauri-rtc.test.ts
pnpm --filter @hivetex/compile exec vitest run test/native.test.ts
```

Without that flag, a machine without native bridge executables skips these optional suites; this does not qualify
as native acceptance. Each skip names the suite, the reason and the command that enables it, and the end of the run
repeats every skipped suite ("N native suite(s) skipped; this run is not native acceptance"). Missing Cargo, a failed
rebuild, or missing TeX in the required job fails the test run.

## Tests and the firewall

Local tests never open a socket on a real network interface, so Windows never asks about the firewall and no
`hivetex*` rule is created by a test run:

- **Rust.** In `cargo test`, `Transport` binds `127.0.0.1` and `RtcState` uses the `loopback` interface policy: host
  candidates on loopback only, no mDNS socket. Tests that need the machine's real interfaces are lab tests, marked
  `#[ignore]` and run on purpose: `cargo test --locked --lib muxed_gathering_keeps_ipv6 -- --ignored`, or `make rtc-lab`.
- **Bridges.** `tauri-rtc.test.ts` creates every `rtc_cli` peer with `interfaces: "loopback"`, which also binds the
  shared listener on `127.0.0.1`.
- **Server and browsers.** The local server listens on `HOST` (default: every interface). Playwright and the local
  tests start it with `HOST=127.0.0.1`.
- Only `make sandbox-sync` and `make rtc-lab` listen on real interfaces, because they talk to Windows Sandbox.

One exception remains: in the browser tests with several peers, Playwright's Chromium (`chrome-headless-shell.exe`)
opens its WebRTC UDP sockets on `0.0.0.0` and `::`, and Chromium has no setting that keeps WebRTC on loopback. The
check below reports these sockets (exit code 3) for the Playwright run. The project's own processes (`node.exe`,
`rtc_cli.exe`, the Rust test binaries) stay on loopback. With the firewall on, Windows may ask once about Playwright's
Chromium; that prompt concerns the test browser, not HiveTeX.

To check a run, `apps/desktop/e2e/endpoints.ps1` samples the UDP endpoints and TCP listeners of every process the
command starts and exits with 3 if one is not on loopback (outgoing TCP connections are listed, not judged):

```powershell
$env:CARGO_TARGET_DIR = "$env:TEMP\p2platex-acceptance-cargo-target"
powershell -File apps/desktop/e2e/endpoints.ps1 -Command 'cargo test --locked --lib -- --test-threads=1' -Cwd apps/desktop/src-tauri
powershell -File apps/desktop/e2e/endpoints.ps1 -Command 'pnpm --filter @hivetex/sync test'
```

With the host firewall on (Public and Private profiles), the same runs must show no prompt. To check that no rule was
created, compare the rule count before and after:

```powershell
(Get-NetFirewallRule -DisplayName 'hivetex*' -ErrorAction SilentlyContinue).Count
```

## Build output and volumes

Cargo writes large outputs. Put them on a volume with space:

| Variable | Used by | Default |
| --- | --- | --- |
| `CARGO_TARGET_DIR` | `cargo test`, the native bridge suites | `apps/desktop/src-tauri/target` |
| `E2E_TARGET_DIR` | the E2E app build (`make desktop-e2e`, lifecycle, background, `make sandbox-sync`) | `CARGO_TARGET_DIR`, else `src-tauri/target/e2e` |
| `E2E_OUT` | desktop E2E results | `<E2E target>/e2e-results` |
| `SANDBOX_OUT` | sandbox runs: staged app, logs, `summary.json` | `<E2E target>/sandbox-sync` |

The E2E build never replaces `target/debug/hivetex-desktop.exe`, which `tauri dev` uses: when the E2E target would be
the development target, it moves to `target/e2e`. Before launching, each desktop harness refuses to start while a test
instance (`app.hivetex.desktop.e2e`) is running. A leftover instance would otherwise receive the launch through
single-instance and the test would drive an old build. Each harness ends its apps with `app_quit` and kills them only
if that fails.

## Interoperability with 0.8.0

`packages/sync/test/legacy-peer.test.ts` runs a real 0.8.0 peer: the sync package of release 0.8.0 (git `9aeb8df`),
checked out apart. Without the checkout the suite is skipped with this hint; with `HIVETEX_NATIVE_TESTS=1` it fails.

```powershell
git worktree add --detach "$env:TEMP\p2platex-080" 9aeb8df
cd "$env:TEMP\p2platex-080"; pnpm install --offline --frozen-lockfile
```

`HIVETEX_080_SYNC` names another location of its `packages/sync/src`.

CI runs `pnpm turbo build lint test`: every package's tests at the same time, on a 2-4 vCPU runner. Real-time work
there (crypto, meshes, worker processes, compression) takes several times longer than on a developer machine.
In October 2026 an audit of repeated CI failures found that almost all of them came from a handful of patterns.
None of them was an application bug.

## What failed, and the rule that prevents it

| Cause | Example | Rule |
| --- | --- | --- |
| Fixed wait, then a positive assertion | `await tick(100); expect(seen).toEqual([0, 1, 2])` after a compressed send | Wait for the condition, not for a time: `await expect.poll(() => seen).toEqual(…)` (or the file's `until`/`waitFor` helper). Keep fixed waits only to check that something does **not** happen. |
| Waiting a number of iterations with fake timers | `for (i < 200 && !ready) await flushMicro(1)` while real crypto runs on the thread pool | Bound such loops by real time (`Date` is not faked): `for (const end = Date.now() + 15_000; !ready && Date.now() < end; ) …`. |
| Asynchronous work behind an event | doorbell rings are verified (JWS) asynchronously, so the test asserted before verification ended | Give the component a way to say it is done (`Doorbell.settled()`, `SeedCatalog.settled()`) and await it. |
| Too short per-test limits | the vitest default of 5 s for tests that start real worker processes or stage tens of MB | `vitest.config.ts` (sync, compile) and `apps/web/vite.config.ts` use 30 s and two workers per package under `CI`; the server already used 60 s for PGlite. A real hang still fails. |
| Two writers on one store | a "reopen" helper started a second `ProjectModel` mid-test, whose delayed persistence rewrote old text | Read stored state passively (`stored()` reads `store.load`), or close the second model first. One writer per store, as in the product. |
| A transient state reported as a failure | the catalog showed "wake-up service unreachable" while the push stream was still connecting | Distinct states for "not yet" and "failed"; the test polls for the settled state. |
| Missing CI setup that a developer machine has | desktop e2e had no bundled Node resources (`prepare-worker.mjs`), and no Playwright browser for the desktop/browser tests; the router-matrix job had no pnpm for `setup-node` | Test harnesses prepare what they need themselves (`apps/desktop/e2e/run.mjs` runs `prepare-worker.mjs`), and every workflow job installs its tools explicitly. |
| Latency thresholds tighter than the contract | in-process p95 < 50 ms in `scale.test.ts` | Assert the specified contract (≤ 250 ms on a healthy network), not a lucky local number. |
| Fixtures sharing ids across instances | two `FakeRtcNetwork`s numbered their connections `pc1, pc2, …` independently | Ids in fakes are process-wide. |
| False positives in secret scanning | upstream CI config in vendored sources, a fake ticket in a redaction test | Allowlist paths/patterns in `.gitleaks.toml` with a reason. Removing a file later does not help, because the scan covers history. |

## Checking before you push

- `node scripts/audit-tests.mjs` lists fixed-wait-then-positive-assertion sites. Each remaining one is deliberate,
  for example an exact count that must stay put (a poll would pass early) or a call with side effects (a poll would
  repeat it).
- To reproduce CI contention locally, set `CI=1` (two workers per package) and run `pnpm turbo test --force` while
  other busy processes occupy most cores. Run it several times: one green run proves little about a timing bug.

## Two machines on one PC: `make sandbox-sync`

`apps/desktop/e2e/sandbox-sync.mjs` runs the desktop test build on this PC and inside Windows Sandbox, signs both in
to one server, shares a project and checks every edit arrives. It runs in four phases and stops with a diagnosis
instead of a sync failure when the environment is the cause.

**Prerequisites.** Windows 11 Pro/Enterprise with Windows Sandbox enabled and its `wsb` CLI; Rust, Node 22 and pnpm;
nothing listening on `:3000` (the run starts its own server on every interface, because the sandbox connects to it).
The sandbox window opens: the app needs a signed-in desktop session there. Windows Sandbox runs one instance, so a
running one is stopped first. The app installed on this PC is not touched (the test build has its own identifier).
Free space: 3 GiB on the output volume (`SANDBOX_MIN_FREE_GB`), twice that for the build.

**Phases.**

1. **Preflight**: free space, no leftover test instance, an isolated app profile, and the host firewall, recorded in
   `summary.json` (`Get-NetFirewallProfile -PolicyStore ActiveStore`, the profile of the interface facing the sandbox,
   rules for the exact app and server `node.exe` paths, "Query User" block rules). If that profile is enabled and an
   allow rule is missing, the run stops with `firewall: …` before building.
2. **Sandbox**: `setup.ps1` runs as System and stops at the first error. It turns the sandbox firewall off and verifies
   it, and writes the verified state to `sandbox/setup.txt`. With `FAULT=no-udp` the firewall stays on and blocks
   UDP for the app, verified; the run then checks the route is `relay` with no UDP pair. A fault that is not in effect
   fails the run.
3. **Reachability**, before sign-in: TCP from the sandbox to the host's `:3000`, and a UDP echo both ways using the
   `node.exe` shipped with the app. A failure stops the run with `reachability: …`.
4. **Scenarios** (`SCENARIOS=`, default `basic`):

| Scenario | Checks |
| --- | --- |
| `basic` | a new file and an edit each way, concurrent edits, an edit within 5 s each way, Test connection on both sides |
| `assets` | binary files: the whole tree (id, path, kind, hash) and the bytes' SHA-256 identical on both sides |
| `rename-delete` | concurrent rename/delete and edit/delete: identical trees, every contested file live or in Recovery with its edits |
| `offline` | both sides offline (app offline mode, or `FAULT=offline`: the sandbox firewall), edits, creations and deletions on each, then merged; deletions in Recovery on both sides |
| `crash` | the sandbox app killed during a burst of edits and relaunched: every acknowledged edit on both sides |
| `author` | author and device of each change listed on both sides |
| `recovery` | a full recovery export on each side: the ZIP opens, every file has its bytes, every manifest hash verifies |
| `folder` | a project bound to a folder on each machine: an outside write on the host reaches the sandbox folder and back |
| `compile` | real local builds: this PC with its own TeX (the host app then runs without `--ignore-system-tex`), the sandbox (no TeX) with the managed compiler it sets up; both PDFs carry the document's marker, neither side holds the other's PDF, an error build reports its error and keeps the last PDF, and the sandbox builds again while cut off (package cache) |
| `mixed` | Chromium on this PC (Playwright, `:1420`) with the desktop app in the sandbox |

`SABOTAGE=1` makes both apps discard text and binary files received from the other side: every scenario must then fail, which shows
the scenario can detect a lost edit.

**Variables.** `SANDBOX_OUT`, `E2E_TARGET_DIR` and `SKIP_BUILD=1` (see "Build output and volumes"); `KEEP=1` leaves
everything running; `SERVER=https://…` uses another server; `NO_APP_RELAY=0` adds the application relay;
`TURN_SERVER`/`TURN_USERNAME`/`TURN_CREDENTIAL` make the local server hand out a TURN relay (`set -a; . ./.env.setup;
set +a`); `HOLD_S=300` keeps editing for five minutes with a signaling socket rotation halfway (`ROTATE=0`: none);
`MATRIX=stun,turn,relay,relay-stun,deaf,no-udp` runs one scenario after the other and prints a table with sync within
5 s, hold and rotation. Scenarios that need TURN report "not run: missing credentials" without `TURN_*`.
`HOST_FIREWALL_ASSUME_ENABLED=1` checks the firewall stop; `INTERRUPT_AFTER=<step>` checks the Ctrl+C cleanup.

**Firewall.** On the host the run only records and checks; it never changes the firewall. With the host firewall on,
allow the exact executables once from an elevated shell, with the same `SANDBOX_OUT`/`E2E_TARGET_DIR`:

```powershell
make sandbox-firewall
```

or answer the firewall prompts for the app and `node.exe`. Inside the sandbox the firewall is turned off by the run.
The sandbox scripts use `netsh`, .NET and the service manager, not CIM/WMI cmdlets: since the October 2026 Windows
updates, WMI in Windows Sandbox refuses every caller. When the sandbox's WebView2 registration names a version whose
folder is missing (the host's runtime was updated after the sandbox image), `launch.ps1` points the app at the newest
runtime folder with `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` and records the choice in `sandbox/webview.txt`.

**Results.** `<SANDBOX_OUT>/<run>/summary.json` (`PASS`, `FAIL` or `INTERRUPTED`, with `diagnosis` for an environment
stop) is written also when build or staging fails or the run is interrupted; `timeline.txt` merges both apps' traces
and the server's signaling log by time; `host/` and `sandbox/` hold diagnostics, logs and recovery exports. Ctrl+C
quits the apps, stops the server and the sandbox, and writes the summary.

**Limits.** Both machines are the same physical PC, and the sandbox sits behind Hyper-V NAT on the Default Switch.
This is not two real networks: NAT types, VPNs and routers of real users are covered only by the two-PC test with the
installer (`docs/remaining-verification.md`).

On this setup no direct link between the two apps has been observed: without a relay (`MATRIX=stun`, or a plain run
without TURN and without `NO_APP_RELAY=0`) the link ends at `checks-failed` (runs of 2026-10-13 and 2026-10-18), even
though the reachability phase shows UDP passing both ways. Data scenarios therefore run with TURN and the application
relay:

```sh
set -a; . ./.env.setup; set +a
NO_APP_RELAY=0 SCENARIOS=basic,assets,rename-delete,offline,crash,author,recovery,folder,compile,mixed make sandbox-sync
```

Inside the sandbox, the image allows all outbound traffic through a rule ("Container: allow outbound"), so a default
block policy alone cuts nothing; `FAULT=offline` adds explicit outbound block rules (loopback excepted) and checks that
the host is unreachable.
