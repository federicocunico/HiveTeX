# Tasks

## 1. Confirm the diagnosis

- [x] 1.1 With the reporting user (or a clean Windows VM without TeX), confirm the status bar's compiler item reads "quick compiler (builds stay on this device)" next to "Compiler: none available"; record the outcome in this change (note in design.md Risks) before continuing — verified when the observed text is written down

## 2. Effective mode and compile-target decision

- [x] 2.1 Add `compileTargets()` to `apps/web/src/lib/compile-mode.ts` (design D2) and unit tests in `apps/web/test/compile-mode.test.ts` covering: local policy, leader self, remote leader, nobody leads with/without engine — verify `pnpm --filter @hivetex/web exec vitest run test/compile-mode.test.ts` passes
- [x] 2.2 Add `effectiveCompileMode` to `ProjectSession` and route `policy()` through it (design D1) — verify `pnpm --filter @hivetex/web exec svelte-check` passes
- [x] 2.3 Rewrite `requestCompile()` on top of `compileTargets()` — verify the unit tests from 2.1 and a manual compile alone (desktop dev build with a verified TeX) still shows the PDF once, with a single build in the log

## 3. Compile when the local compiler becomes ready

- [x] 3.1 Call `scheduleLocalCompile(0)` at the end of `setupCompile()` and when `installQuickCompiler()` adopts an engine for the open project (design D3) — verify with the e2e in 3.2
- [x] 3.2 Extend `e2e/compile-modes.spec.ts`: a member on *This device only* opens the project and the PDF appears without editing; with a co-author connected, clicking Compile produces this device's PDF — verify `pnpm exec playwright test e2e/compile-modes.spec.ts` passes

## 4. Status bar

- [x] 4.1 Update `StatusBar.svelte` "who compiles" item per design D4 (effective mode, quick-compiler hint, setting-up state, `data-testid="leader"` kept) — verify the existing e2e (`compile-modes`, `full-flow`) still pass and a new e2e assertion that *This device only* shows "Compiles only on this device"
- [ ] 4.2 Desktop check on a machine/VM without TeX (quick compiler auto-installed, *Automatic*): status shows "Compiles only on this device (quick compiler)", the PDF appears on open, and Compile works with a co-author online — verified by screenshot attached to the change

## Workflow follow-up

- Archive the change after review, syncing the `compiler-provisioning` and `distributed-compilation` deltas.
