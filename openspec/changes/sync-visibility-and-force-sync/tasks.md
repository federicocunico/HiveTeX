# Tasks

## 1. Branch and baseline

- [x] 1.1 Create branch `sync-visibility-and-force-sync` from `master` (leave the unrelated working-copy changes `apps/desktop/e2e/desktop.test.mjs` and `e2e/zz-repro.spec.ts` out of the commits); verify `git branch --show-current`
- [x] 1.2 Run `pnpm -r test` baseline and note existing failures; verify the output is saved for comparison

## 2. Link retry and connection state (`packages/sync/src/connect.ts`)

- [x] 2.1 Remove the 8-attempt cap in `retryLater` while the device is relay-visible or pex-announced (backoff capped at 30 s); verify a unit test that fails 12 links then succeeds connects without user action
- [x] 2.2 Add `candidates()` (online-but-unconnected devices with uname, attempts, linking, lastError) and `reconnectNow()` (reset attempts, close stalled links, reopen socket, connect all known); verify unit tests with the test kit (`testkit.ts`)
- [x] 2.3 Record stage timestamps (relay seen, link up) per device for diagnostics; verify via unit test

## 3. Sync tracker (`packages/sync`)

- [x] 3.1 Add `SyncTracker` fed by Mesh (STEP1 sent, STEP2 applied per doc/peer) and BlobManager (have/pending); `snapshot()` returns stage, files with state, counts, percent, `lastSyncAt`, `stalled`; verify unit tests for list-first, join progress, local-created files counting as received
- [x] 3.2 Add `Mesh.resync()` (re-send STEP1 for every requested doc to every peer, prefetch all text docs) and bulk blob fetch of missing binaries with bounded concurrency; verify a test where a dropped STEP2 is recovered by `resync()`
- [x] 3.3 Throttle change notifications (~4/s) and verify with a 5,000-file project test that snapshot cost stays low

## 4. Session wiring (`apps/web/src/lib/session.svelte.ts`)

- [x] 4.1 Expose reactive `syncStatus`, `connecting` (co-authors online but not linked) and `syncNow()` returning a summary; keep `peers` = connected links only; verify unit test in `apps/web/test`
- [x] 4.2 Emit notifications for "all files received" and "no progress for 60 s with files missing"; verify unit test with a fake clock
- [x] 4.3 Expose diagnostics on `window.__p2p` in test mode; verify from an e2e test

## 5. UI

- [x] 5.1 StatusBar: replace "All changes synced" with the truthful sync item (percent, last sync, waiting, offline) and a "N connecting" count in the people item; verify the existing `statusbar`/`peer-count` e2e tests are updated and pass
- [x] 5.2 New `SyncPanel.svelte`: stage, progress bar, per-file list with state and editors, last sync time, "Sync now" with result message; reachable from the status bar and the rail; verify component test and keyboard access
- [x] 5.3 PeoplePanel: list connecting co-authors as "connecting"; FileTree: muted marker on files not yet received, existing presence dot for editors; verify component tests
- [x] 5.4 Notification display (toast or `pill role="status"`) for the two sync notifications; verify a11y live-region test

## 6. End-to-end and docs

- [x] 6.1 e2e: second device joins a project with many files over a throttled/delayed link; file list appears before contents, percent rises, notification on completion, "Sync now" works; verify Playwright run passes
- [x] 6.2 e2e: peer visible on relay but link delayed shows "connecting" then "online"; verify Playwright run passes
- [x] 6.3 Update user docs (`docs/`) for the Sync panel and "Sync now"; verify the doc matches the UI strings
- [x] 6.4 The reported project `df72heljrgs56wmo` and its data are not available here, so it cannot be replayed; instead the mechanism is reproduced by `server/test/p2p-e2e.test.ts` (12 stalled attempts, more than the old cap of 8, now connect on their own) and the stage timestamps are exposed through `session.syncDiagnostics()` for the next slow join

## Workflow follow-up

- Run `/opsx:apply` when ready; archive the change after review.
