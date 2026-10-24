# Selective compiler review

Reviewed the uncommitted `stabilize-authoring-workspace` implementation on 2026-10-24/25, against `HEAD` (`2a8d2ed`). No production changes, full builds, downloads, commits or pushes were performed. Exactly one reviewer worked at a time.

## Resolution follow-up

All three findings below are now fixed in the working tree. The original review descriptions/evidence are retained for traceability.

- Distribution publishers now use uniquely owned `apps/web/.texlive-staging-*` directories outside Vite's public tree, on the destination volume. Pruning never removes sibling staging. Each invocation removes only its own publish/extraction scratch in `finally`, including a failed or losing atomic publication. Shared download cache entries also publish by atomic rename from owned temporary files, so another preparation cannot extract partially written bytes. The new private staging pattern is ignored by Git.
- Converter runners retain the normal startup allowance; the existing shared XeTeX execution abort deadline bounds each current conversion attempt. A shortened prior attempt cannot poison retry startup.
- Runner stop generations invalidate asynchronous preparation/startup/build continuations. Stop/abort after preparation resolution cannot create a worker, disposal during startup's ready handoff cannot send input to a terminated worker, and a subsequent valid retry can still succeed.

Permanent regressions were added to `apps/web/test/wasm-runner.test.ts` and the new `apps/web/test/tex-distribution.test.ts`. The generator test uses two concurrent preparations of an isolated tiny local tar fixture: it pauses one download while the other publishes, confirms active staging survives the ready-output path, checks that the public tree contains only the complete immutable distribution, then releases the slower publisher and checks cleanup. It performs no production-resource download/build. WASM tests cover stop and abort during the preparation microtask gap with successful retry, disposal at startup handoff, and successful converter retry after the old deadline would have expired.

Final selective validation:

- `pnpm --filter @hivetex/web exec vitest run test/wasm-runner.test.ts test/tex-cache.test.ts test/tex-distribution.test.ts`: **3 files / 21 tests passed**, 5.07 s. Rerun after the final atomic-download change.
- `pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json`: **0 errors, 12 existing warnings in 7 files**.
- No full browser/build/package acceptance, commits or pushes in this fix phase. The generator source contributes to the distribution identity; production resources and recorded manifest identity must be regenerated/refreshed in the planned final serialized acceptance pass.

## Original findings

### P2: Distribution preparation removes another active publisher's staging directory

**New code:** `scripts/tex-distribution.mjs:44-52`, especially the `.staging-*` match at line 46 and recursive removal at line 49.

Two Vite processes sharing a checkout can both enter cold preparation before a manifest exists. When the first publishes, its pruning removes the other process's still-active `.staging-*` directory. The second process then fails writing resources or renaming its directory, even though all inputs are valid. The ready-output path also prunes without checking whether another process owns a staging directory. This affects overlapping development/build invocations; it does not require CI jobs to share a machine.

**Evidence:** Ran the exact generator copied to a temporary repository root with empty engine inputs, a ready manifest and a simulated active sibling staging directory containing an in-progress resource. Preparation returned successfully, but `activePreparationSurvived` was `false`. This exercises the actual pruning code without expensive concurrent builds or touching the real generated distribution. Reproduction: `node docs/evidence/authoring/review-compiler-generator.mjs` from the repository root.

**Correction:** Give preparation exclusive ownership before pruning/publishing, or clean up only staging directories owned by the current invocation. A regression should coordinate two isolated preparations at their publish boundary and assert that both settle successfully without removing live output owned by the other invocation.

### P2: An almost-expired first XeTeX build permanently shortens converter startup retries

**New code:** `apps/web/src/lib/wasm-engine.ts:342`; the retained converter `Runner` captures `Math.min(30_000, remaining)` once. `Runner.start()` subsequently uses that original value at line 159.

If the first XeTeX pass consumes most of the execution budget, the newly created converter receives a very small startup allowance. When it times out, `stop()` resets its worker but retains the `Runner` in `runners.dvipdfm`. A later explicit retry with a fresh, much larger remaining budget still uses the original small startup limit. The converter can therefore keep failing startup until the project/engine is recreated or its cache is cleared.

**Evidence:** A fake-clock probe used a 1000 ms budget and completed the first TeX pass at 900 ms. The converter was stopped after its 100 ms allowance. On retry, XeTeX completed immediately, leaving approximately 1000 ms, but the new converter worker was still terminated after 100 ms. The assertion that it remains alive at 101 ms failed (`expected 1 to be 0` termination calls).

**Correction:** Apply each attempt's remaining deadline to that attempt, without storing a previous attempt's reduced budget in a retained runner. The outer XeTeX abort already bounds conversion startup/execution. Promote the retained probe into `wasm-runner.test.ts`, including a retry that becomes ready later than the old allowance but before the new deadline.

### P2: Stopping between preparation resolution and startup can still create a worker

**Inherited defect, relevant to the cancellation/disposal contract:** `apps/web/src/lib/wasm-engine.ts:143-147`. The same promise/finally/startup ordering exists in `HEAD`; this change did not introduce it.

After preparation resolves the outer promise but before its `finally`/`await` continuation runs, `stop()` invokes a rejection callback on an already-resolved promise. That rejection has no effect. Startup then constructs a worker without checking a cancellation generation or aborted state. An abort/dispose in this microtask interval can return from `stop()` and subsequently acquire a new worker. It may remain alive until startup/build completion or timeout, contrary to the documented worker disposal contract.

**Evidence:** Resolve a deferred preparation promise, then queue `runner.stop()` in the following microtask. After flushing microtasks the probe observes one newly created worker, although the assertion requires zero. The probe stops it a second time for cleanup. Existing immediate-cancel tests do not exercise this ordering.

**Correction:** Invalidate asynchronous startup with an ownership/generation token and check it after preparation and before publishing/using a worker; retain normal retry support. Promote the probe into `wasm-runner.test.ts` and also exercise the engine's `dispose()`/abort entry points.

## Selective checks and scope

- Read tracked diffs and relevant untracked sources: WASM runner and new XeTeX/Dvipdfmx pipeline; worker resource adapter; distribution generator/lock; service worker/cache tests; Account override migration; Vite/Turbo inputs; browser CI lanes; Rust endpoint cache, package deadline/index repair changes; scheduler/session integration and representative regression fixtures. Read acceptance/design documents as context, not independent proof.
- Read targeted startup, lookup and output snippets in vendored workers; did not dump or modify the minified assets. The converter reads XDV and returns PDF; the bundled adapter preserves matching content-addressed font IDs.
- Confirmed endpoint-specific cache names, retention of old bundled-cache namespaces, content-addressed download verification, atomic same-volume distribution publish, generated-input cache invalidation, checksum pins and accompanying package provenance/source archive handling by inspection. No additional concrete defect was established in those paths.
- Ran only the isolated generator probe and two focused Vitest probes. Vitest: **2 tests failed as expected**, reproducing the retry defect and inherited cancellation defect, in 3.56 s. No existing passing suites were rerun.
- The supplied successful real-template matrix, production UI runs and prior unit/native results were not repeated or treated as proof against untested races.

The two original Vitest probes are preserved outside normal discovery in `docs/evidence/authoring/review-compiler-probes.vitest.txt`. To reproduce, copy that file to `apps/web/test/review-compiler-probe.test.ts`, run `pnpm --filter @hivetex/web exec vitest run test/review-compiler-probe.test.ts`, then remove only the copied file. Its imports intentionally resolve from that test location. These desired-behavior assertions failed before the fixes; the permanent regressions now cover the same cases and additional shutdown/retry behavior.

## Residual gaps

No Linux/macOS build or WebView execution, remote CI, full archive/license audit, actual concurrent heavyweight builds, or end-to-end browser upgrade with an older running tab was performed. Existing service-worker tests demonstrate old bundled-cache retention and serving an old open tab; they do not establish fallback from a failed new distribution to the previous app/compiler after all old tabs close. No claim of such fallback is made here. Concurrent calls directly into one `Runner` were not validated; the product `LocalCompiler` serializes builds. Rust's pre-existing shared temporary-file pattern and global custom-upstream protocol were read but no new reachable regression was demonstrated.

The two new P2 findings and the inherited cancellation gap are resolved by the follow-up above. Final production-distribution acceptance remains deferred as requested.
