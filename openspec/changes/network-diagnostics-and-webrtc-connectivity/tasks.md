# Tasks

## 1. Reproduce and fix signaling races

- [x] 1.1 Add a failing test in `packages/sync/test/connect-lifecycle.test.ts` (delayed `getIceServers`, `ice` envelope before `offer` processing) and verify it fails on current code
- [x] 1.2 Buffer early `ice` envelopes per peer and apply them once the link exists; verify 1.1 passes and the sync test suite stays green
- [x] 1.3 Record stage and cause for each failed attempt in `connect.ts`; verify unit tests for timeout, no-candidates and checks-failed causes

## 2. Connection data capture

- [x] 2.1 Capture ICE state, local/remote candidate types and selected pair in `RtcLink` (browser and Tauri factory); verify with fake-RTC tests
- [x] 2.2 Return relay availability and reason from `/turn` and keep clients compatible with the old shape; verify `server/test/signal.test.ts`
- [x] 2.3 Expose desktop port-mapping status to the page data source; verify with a Rust/unit test

## 3. Networking page

- [x] 3.1 Implement probes (signaling, ICE config, STUN, TURN) with applicable/not-applicable handling; verify unit tests and manual run in browser
- [x] 3.2 Build the Network diagnostics view with per-peer connection details and link it from workspace and account; verify a Playwright test renders results
- [x] 3.3 Implement peer test and redacted *Copy report*; verify a test asserting no credential or token appears in the report
- [x] 3.4 Add the People panel cause text and a link to the page; document the page in `docs/` and update TODO.md

## 4. Connection trace in sync tests

- [x] 4.1 Add an optional trace callback to the connection manager and link covering configuration, attempts, setup messages (including held ones), candidates, state changes, causes, retries and relay fallback, redacted by construction; verify with a unit test that asserts the event order of a failed and a successful connection and that no credential appears
- [x] 4.2 Record every participant's trace in the sync test helpers and print the merged, relative-time trace when a test fails; verify with a deliberately failing test run that shows the output
- [x] 4.3 Capture the trace from the web app in Playwright and desktop e2e sync tests and attach it on failure; verify with a forced failure

## 5. Live investigation and integration

- [x] 5.1 Run the browser sync specs (`realtime`, `presence`, `sync-status`, `network-diagnostics`, `doorbell`, `auth-and-collab`) against the dev stack and confirm they pass with the trace fixture; record results in the commit message

## Workflow follow-up

- Verify on two real devices on different networks (the reported project): open Network diagnostics on both, run *Test connection*, and read the stage and cause. *No relay is configured* means the Cloudflare TURN keys are still to be set (TODO.md); other causes become new tasks with a reproducing test.
- Run the desktop e2e (`pnpm --filter @hivetex/desktop e2e`) and the router matrix (`apps/desktop/e2e/netlab`, Linux root) once the native build is available; the desktop WebDriver trace output is only syntax-checked here.
- Archive the change after review.
