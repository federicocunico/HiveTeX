# Tasks

## 1. Group-scale sync

- [x] 1.1 Add an immediate-delivery test transport and `packages/sync/test/scale.test.ts` measuring frames per edit, propagation p95 and concurrent convergence for 2/6/8/12 peers; verify it currently reproduces the (N-1)² amplification (expected failure documented in the commit) before the fix
- [x] 1.2 Implement neighbor-aware relaying (`nbrs` APP topic, relay rule, remove `relayThreshold`); verify `scale.test.ts` passes (N-1 frames per edit, p95 < 50 ms, all insertions converge) and partial-mesh + late-joiner tests deliver everything; existing sync tests pass
- [x] 1.3 Benchmark script (`pnpm --filter @p2platex/sync bench`, `make bench`) printing p50/p95/max, frames per edit and convergence for 2…16 peers; verify it runs and record the results in `docs/performance.md`
- [ ] 1.4 `e2e/realtime.spec.ts`: 7 browser users over real WebRTC, keystroke latency p95 < 250 ms logged, and concurrent typing by all 7 converging with every token; verify it passes locally (`make e2e`) and on CI, and add the measured numbers to `docs/performance.md`

## 2. Desktop and server fixes

- [x] 2.1 CORS for desktop origins on `/api/*` (no credentials); verify server tests: preflight from `http://tauri.localhost` gets the allow headers, a request from `https://evil.example` gets none, web same-origin unaffected
- [x] 2.2 Stop advertising Tectonic (its reads cannot be verified, see design D4): `detect()` returns no engine for a Tectonic-only machine; verify a Rust test that detection never reports a tectonic flavor and that the desktop shows the install-TeX note when no engine is found
- [x] 2.3 Background verification email on register + `POST /auth/resend-verification` + Account page button; verify server tests: failing mailer still returns 201 and signs in, resend works for unverified users and is rate-limited
- [x] 2.5 Mirror stability check: import a disk change only after two consecutive identical reads (found during apply: a truncated file was merged as "everything deleted", reordering a co-author's concurrent line); verify the mirror test "applies a minimal diff, preserving a concurrent remote edit" passes 30 runs in a row
- [x] 2.6 Link setup timeout and retry with backoff in ConnectionManager (found during apply: on the 2-vCPU CI runner the 7-browser mesh never completed, because a stalled WebRTC attempt was never retried); verify a server p2p test where the first two attempts stall: it fails without the fix and the mesh completes with it
- [x] 2.4 Stack nginx uses `$remote_addr` for `X-Forwarded-For`; verify on `make up` that a spoofed `X-Forwarded-For` does not change the rate-limit key in Redis

## 3. Integration

- [ ] 3.1 `make check` and CI (CI + Desktop workflows) green on a pushed branch with the new tests; verify the realtime e2e numbers in the CI log match `docs/performance.md` within expectations
