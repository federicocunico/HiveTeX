# Verification record (group 9)

Date: 2026-10-11. Worktree `F:\github\p2platex-harden`, branch `feat/harden-realtime-peer-sync`, Windows 11, Node 22, pnpm 10.34.6, Chromium via Playwright, Docker Desktop 29.8. Commits of groups 1-8 are on the branch; this record covers the final gates.

## 9.1 Unit, integration, type and lint gates

Turborepo guidance was read first: `node -p "require.resolve('turbo/package.json')"` resolved `turbo@2.11.7`; `docs/README.md`, `reference/run.mdx` and `crafting-your-repository/running-tasks.mdx` of that package were read before running `turbo run`. The commands are the ones of `.github/workflows/ci.yml` and `make check` (`build lint typecheck test size e2e`). Turbo's managed block in `AGENTS.md` was reverted after each run (`git checkout -- AGENTS.md`).

| Command | Result |
| --- | --- |
| `pnpm turbo run build lint test --force` (27 tasks, no cache) | exit 0, 27/27 tasks successful |
| ... `@hivetex/protocol` test | 1 file, 3 tests passed |
| ... `@hivetex/crypto` test | 1 file, 7 tests passed |
| ... `@hivetex/github` test | 2 files, 28 tests passed |
| ... `@hivetex/sync` test | 26 files, 249 tests passed |
| ... `@hivetex/compile` test | 5 files passed, 1 skipped; 55 tests passed, 2 skipped (pre-existing skips, not run here) |
| ... `@hivetex/web` test | 31 files, 258 tests passed |
| ... `@hivetex/server` test (signaling, p2p e2e, accounts, projects, github) | 8 files; 101 tests passed, 4 skipped (the Redis half of the new backend parity test, run separately in 9.3 with `UPSTASH_REDIS_REST_URL` set) |
| `pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json --threshold error` | 498 files, 0 errors, 11 warnings |
| `pnpm --filter @hivetex/web build && pnpm --filter @hivetex/web size` | initial JS 152.3 KB gz, budget 250 KB: within budget |
| `pnpm audit --audit-level=high` | 1 moderate vulnerability reported, none high: the CI gate (high) passes. No dependency changes were made by this change. |

Regression found by the gate and fixed: the first version of the new `server/test/signal-backend-parity.test.ts` did not type-check (`server#build` failed with TS2322); corrected and the full run repeated (the table above is the repeat).

Not run: `make check` itself (the underlying commands were run directly), the Makefile smoke steps, `docker compose config` and gitleaks (unrelated to this change).

## 9.2 Real-browser scenarios and performance

`pnpm exec playwright test --reporter=list` (full suite, dev API and Vite started by the Playwright config, one worker): **74 passed, 2 skipped (the two `screenshots.spec.ts` documentation generators), 0 failed**, 3m57s. The run includes the collaboration (`auth-and-collab`, `realtime`, `presence`, `share`), offline merge (`offline-and-compile`, `offline-merge`), sync status (`sync-status`), and editor/folder (`editor-and-folders`, `folders`, `files-menu`) specs together.

Gap closed: no test covered a reconnect with a binary transfer in flight. Added:

- `e2e/offline-and-compile.spec.ts` "reconnect with a binary transfer in flight: the exact bytes arrive and the status settles": the owner adds a 24 MiB incompressible `big.png`, the guest joins, the test waits until the first chunks arrived but the blob is not complete (asserted: not yet held), the guest goes offline, the owner types while the link is down, the guest resumes. Asserted: the received blob has the exact length and SHA-256, the shared text of both sides is identical and contains the typing once, and the status bar returns to "All changes synced". Passed 3 of 3 repeated runs (`--repeat-each 3`). It was run once more after being added to the file: `pnpm exec playwright test e2e/offline-and-compile.spec.ts` 3 of 3 passed.
- `packages/sync/test/blobs.test.ts` "a link dropped mid-transfer neither corrupts nor leaks": 60-chunk blob over a latency link, cut after the first chunks, relinked; the exact bytes arrive and `pending` no longer holds the hash (settled).

Numbers, healthy test topology (seven Chromium contexts over real WebRTC, `e2e/realtime.spec.ts`): keystroke-to-screen **p50 2.7 ms, p95 6.0 ms, max 8.3 ms** (180 samples; the assertion is p95 < 250 ms); 7 users x 10 concurrent edits converged in 250 ms. This is a loopback figure on a developer machine, not an internet-path result.

12-peer relay efficiency (`packages/sync/test/scale.test.ts`, asserts frames per keystroke equal peers - 1): N=12 p50 0.38 ms, p95 1.13 ms, **11.0 frames per keystroke (= N-1, no redundant relay)**; N=2 1.0, N=6 5.0, N=8 7.0; 12 peers x 20 concurrent edits converged in 78 ms; partial-mesh, chain and late-joiner cases pass. `pnpm --filter @hivetex/sync bench` (immediate delivery): 12 peers p95 0.79 ms, 11.0 messages per keystroke; 16 peers 15.0; with 20 ms one-way latency 12 peers p95 32.9 ms, 14.3 messages per keystroke (the "at most 14" recorded in `docs/performance.md`, rounded).

## 9.3 Compatibility matrix

Executed means the command ran in this worktree and passed. Nothing in the not-executed rows is claimed as passed.

| Area | Check | Status | Evidence |
| --- | --- | --- | --- |
| Mixed legacy/current clients | Receipt-capable and `receipts:false` (legacy STEP1/STEP2) peers in both directions: no success inferred from an unrelated UPDATE, one exchange per document and connection, a legacy requester completes against a current peer | Executed, passed | `packages/sync/test/reconcile.test.ts`, `fork-confirm.test.ts` |
| Version-1 journal and restart fixtures | v1 forked/merging/conflict records migrate additively, failed migration keeps the old records, unknown journal versions are never modified or deleted, restart from every journal stage, v1 and v2 side by side, downgrade-readable mirror | Executed, passed | `packages/sync/test/fork-journal.test.ts`, `fork-typing.test.ts`, `durability.test.ts` (IndexedDB and memory `transact`) |
| Browser restart persistence | Offline edits survive a reload before reconnecting and merge | Executed, passed | `e2e/offline-and-compile.spec.ts`, `e2e/offline-merge.spec.ts` |
| Signaling backend, in memory | Per-device lease expiry, compare-and-set renew/remove, pub/sub | Executed, passed | `server/test/signal.test.ts`, new `server/test/signal-backend-parity.test.ts` (memory half) |
| Signaling backend, real Redis | The same contract against the production `createUpstashSignalBackend` on a disposable Redis 7 plus the repository's Upstash REST emulator: `docker compose -p hivetex-parity up -d redis srh upstash`, then `UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=dev-stack-token pnpm --filter @hivetex/server exec vitest run test/signal-backend-parity.test.ts test/signal.test.ts test/p2p-e2e.test.ts` | Executed, passed: 36 of 36 tests including the 4 Redis tests (stack removed afterwards). Without the variables the 4 Redis tests are skipped. A local emulator, not Upstash cloud. | `server/test/signal-backend-parity.test.ts` |
| Backend difference found, not a defect | Removing the session's own lapsed entry: Redis keeps it until a read prunes it (returns true, so the leave is still announced); the memory backend drops it when the earlier renew looks at it. Harmless. The parity test pins what both guarantee: nothing remains and a second removal finds nothing. | Documented | comment in the parity test |
| Native RTC adapter faults | IPC send failure closes the owning transport, no gap in a fragment stream, a hung IPC settles on peer close, local close and Rust-reported close; full authenticated mesh handshake and CRDT sync over the Rust bridge | Executed, passed: 6 of 6 (`npx vitest run test/tauri-rtc.test.ts` in `packages/sync`, with `apps/desktop/src-tauri/target/debug/examples/rtc_cli.exe` present) | `packages/sync/test/tauri-rtc.test.ts` |
| Rust shell | `cd apps/desktop/src-tauri && cargo test --lib` | Executed, passed: 48 passed, 0 failed, 4 ignored. This change modified no Rust source. | |
| Controlled relay-only reconnection | Two Chromium contexts with `iceTransportPolicy: "relay"` and a disposable coturn (`docker compose --profile turn up -d turn`, user dev, 127.0.0.1:3478): connect, edit, go offline, edit, resume; the selected candidate pair is `relay/*` before and after; each edit arrives exactly once | Executed, passed: `RELAY_ONLY=1 pnpm exec playwright test e2e/relay-only.spec.ts`, 1 of 1, coturn logged allocations. New spec, skipped unless `RELAY_ONLY=1` so CI needs no relay. | `e2e/relay-only.spec.ts` |
| TURN credential refresh and failure | Expiry refresh, failed first acquisition retried, hang bounded, rate limit honoured | Executed, passed (fake clock) | `packages/sync/test/connect-lifecycle.test.ts` |
| Real TURN provider (Cloudflare), real NAT and internet paths | | Not executed: no credentials, no remote devices | |
| Real devices: packaged desktop app on Windows/macOS/Linux, mobile browsers, Safari, Firefox | | Not executed: only Chromium and the Rust bridge CLI on this Windows machine | |
| Desktop UI (tauri-driver, WebDriver) | `make desktop-e2e` | Not executed | |
| Production Upstash cloud, Neon, Vercel deployment | | Not executed (no deployment or push, by instruction) | |
| Older released client builds against this branch | | Not executed: simulated only through `receipts:false` and the v1 fixtures; no old build was available | |

## 9.4 OpenSpec validation and finding mapping

`openspec validate harden-realtime-peer-sync` (from the worktree): **Change 'harden-realtime-peer-sync' is valid**.

Test names are the `describe` blocks (their `it` names are in the files). Paths are relative to the repository root.

| ID | Fix | Regression evidence |
| --- | --- | --- |
| F01 | `packages/sync/src/persistence.ts` (retained batches, backoff, `saveState`), `apps/web/src/lib/session.svelte.ts`, `StatusBar.svelte` | `packages/sync/test/durability.test.ts` "DocPersister retains failed writes (F01)"; `apps/web/test/save-warning.test.ts` "local save failures reach the workspace" |
| F02 | `packages/sync/src/fork.ts` (journal v2, stages), `model.ts`, `persistence.ts` (`transact`) | `fork-journal.test.ts` "restart from every journal transition (F02)", "recovery journal (version 2)"; `durability.test.ts` "document replacement is serialized with writes (F02)", "Persistence.transact is atomic"; `fork-typing.test.ts`; `e2e/offline-merge.spec.ts` |
| F03 | `fork.ts` (confirmed rounds), `mesh.ts` (the gate fails closed) | `fork-confirm.test.ts` "merge input must be confirmed", "F03 over the mesh", "F03: failed preparation never shares the offline work"; `reconcile.test.ts` "document reconciliation (5.2)" |
| F04 | `model.ts` (availability-checked, revalidated dedupe) | `availability.test.ts` "safe identical-file consolidation (5.5, F04)", "local completeness is separate from loaded or stored documents (5.1)" |
| F05 | `mesh.ts`, `connection.ts` (verified epoch evidence only) | `epoch-authority.test.ts` "authoritative membership epochs (F05)"; `mesh.test.ts` |
| F06 | `packages/github/src/agent.ts` (fail before any remote change), `packages/sync/src/snapshot.ts`, `apps/web/src/lib/recovery-export.ts` | `packages/github/test/agent.test.ts` "complete backup acquisition (8.4, F06)"; `snapshot.test.ts` "complete immutable project acquisition (8.1, F06, F14)"; `apps/web/test/export-complete.test.ts` |
| F07 | `apps/web/src/lib/session.svelte.ts`, `keys.ts`, `api.ts` (separate identity, registration and keys; online recovery) | `apps/web/test/session-recovery.test.ts` "recovery after offline startup (F07)" |
| F08 | `server/src/signal/hub.ts` (per-device leases, compare-and-set), `packages/sync/src/connect.ts` (heartbeat, session ids) | `server/test/signal.test.ts` "per-device presence leases (F08)"; `server/test/signal-backend-parity.test.ts` (memory and real Redis); `connect-lifecycle.test.ts` "signaling heartbeat and session ids (F08)" |
| F09 | `connect.ts` (refreshing, shared, bounded credential cache), `session.svelte.ts` | `connect-lifecycle.test.ts` "relay credentials (F09)"; `e2e/relay-only.spec.ts` (relay path, opt-in) |
| F10 | `connect.ts`, `session.svelte.ts` (attempt slot, generation checks, owned timers) | `connect-lifecycle.test.ts` "connection lifecycle ownership (F10)"; `session-recovery.test.ts` "session-owned work stops with the session (F10)" |
| F11 | `transport.ts`, `tauri-rtc.ts` | `transport.test.ts` "transport cancellation (F11)"; `tauri-rtc.test.ts` "native RTC send failures and cancellation (F11)"; `blobs.test.ts` "reconnect with a binary transfer in flight (9.2)" |
| F12 | `transport.ts` (bounded assembly), `blobs.ts` (chunk, byte and range limits), `connection.ts` | `transport.test.ts` "bounded fragment assembly (F12)"; `blobs.test.ts` "blob chunk validation (F12)", "blob sources (F12)", "blob request ranges (F12)"; `handshake.test.ts` "inbound queue budget (F12)", "outbound frame ordering (F12)" |
| F13 | `packages/sync/src/sync-status.ts`, `apps/web/src/lib/sync-view.ts` | `sync-retry.test.ts` "missing-content retries follow identity, source and generation (5.3, F13)"; `sync-outcome.test.ts` "status and manual sync follow current reconciliation (5.4, F13)"; `apps/web/test/sync-view.test.ts`; `e2e/sync-status.spec.ts` |
| F14 | `packages/compile/src/pipeline.ts`, `packages/sync/src/snapshot.ts` | `packages/compile/test/pipeline.test.ts` "complete immutable inputs and result identity (8.2, F14)"; `snapshot.test.ts` |
| F15 | `packages/sync/src/mirror.ts` | `mirror-baseline.test.ts` ("baseline from equal content", "disk writes", "initial binding and content readiness"); `e2e/editor-and-folders.spec.ts` folder tests |
| F16 | `apps/web/src/components/Editor.svelte` | `apps/web/test/editor-mount.test.ts` "Editor mounting"; `e2e/editor-and-folders.spec.ts` "editor: a file that loads late never takes over the editor ..." |
| F17 | `packages/github/src/agent.ts` | `agent.test.ts` "backup completion acknowledges only captured edits (8.5, F17)" |
| F18 | `mesh.ts`, `connection.ts` (generation and role recheck, per-device ticket watermark) | `epoch-authority.test.ts` "current authorization for delayed work (F18)", "privileged application messages (3.3)" |

All 18 findings have implementation and regression evidence.

### Deferred boundaries (checked against design.md)

`design.md`, "Specification tensions and deferred boundaries", states them accurately and this group did not change them: (1) viewers still cannot bootstrap or relay (also in `docs/security.md`, "A viewer cannot bootstrap a newcomer"; the lack of an eligible source is reported, not worked around); (2) the explicit demotion policy is unchanged (tests assert a demoted member never publishes offline work); (3) multi-tab use of one device identity is not addressed and no seamless multi-tab support is claimed; (4) native Rust filesystem and compiler internals, account races, dependency advisories, IME and undo behavior and internet-path latency remain outside the audit, while the native RTC adapter is covered by the F11 tests above. The multi-tab limitation is recorded only in `design.md`; no user-facing document mentions it.
