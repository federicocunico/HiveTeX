# Selective workspace review

Reviewed the uncommitted `stabilize-authoring-workspace` implementation against `HEAD` (`2a8d2ed`) on 2026-10-24. Exactly one reviewer worked at a time. No production edits, full-suite reruns, builds, commits, pushes or archive operations were performed in the initial review phase. The subsequent correction and selective validation are recorded below. The earlier compiler review and its three resolved findings are documented separately in `review-compiler.md`; that investigation was not repeated.

## Resolution follow-up

Both confirmed findings are fixed in the working tree. The original descriptions and failing evidence below are retained for traceability.

- PdfRenderer now owns a ResizeObserver for its scroller, compares actual viewport dimensions to avoid work on unchanged notifications, refreshes the visible-page window when dimensions change, and disconnects on close. The existing two-job/six-canvas bounds remain unchanged.
- The last meaningful reading anchor is retained independently of the current generation's wrappers. Empty loading generations reuse that anchor, so a newer zoom/output replacement preserves it. Existing active-generation checks prevent superseded completions from restoring or modifying newer output.
- Permanent regressions in `apps/web/test/pdf-renderer.test.ts` verify newly exposed page rendering without scrolling, unchanged-size no-op behavior, shrinking/eviction, observer cleanup and harmless late notification, retained source focus, overlapping zoom/output loads and late superseded completion after newer navigation.

Selective validation: `pnpm --filter @hivetex/web exec vitest run test/pdf-renderer.test.ts test/pdf-revision.test.ts`: **2 files / 10 tests passed**, 5.71 s. `pnpm --filter @hivetex/web exec svelte-check --tsconfig ./tsconfig.json`: **0 errors, 12 existing warnings in 7 files**. No full suites or visual baseline regeneration were performed.

The expanded `e2e/pdf-preview.spec.ts` browser journey passed with zero retries: **1/1**, 7.5 s test / 15.3 s total. It retains the existing 100-page/distant-scroll/landscape/anchor/focus checks, then starts with a 500 px window at 50%, confirms page 3 is uncached, grows to 1400 px without scrolling and verifies page 3 renders while source focus and the six-canvas bound remain intact. The first executed version of the extended fixture queried wrappers immediately after rapid zoom changes; it failed on an absent loading-generation wrapper. Waiting for the latest placeholders before positioning the test fixed that fixture timing, without another production change.

The first browser attempt never entered a test: Vite resource preparation exceeded the normal 300 s webServer startup budget. A single dedicated `node scripts/tex-distribution.mjs` preparation then completed in approximately 20 s, producing **tl2019-5eed4a4ac9c250ecc67f2f74 / 4311 resources**, and subsequent browser startups used the ready distribution. No timeout was changed. This is recorded as a startup-harness limit; the cause of the much slower preparation under Vite was not independently investigated.

Automatic policy review rejected cleanup of the abandoned first-attempt `apps/web/.texlive-staging-nud2G5` and `%TEMP%/hivetex-tex-distribution-xNdeB1` directories with only `blocked by policy`. Their prior Vite process had ended; the directories were left in place and no equivalent cleanup was retried. The successful dedicated preparation cleaned its own staging/scratch directories normally.
## Confirmed findings

### P2: Resize does not refresh the virtualized PDF render window

**Location:** `apps/web/src/components/PdfView.svelte:84-91`; `apps/web/src/lib/pdf-renderer.ts:83-99`.

The preview updates its desired pages on scrolling, page navigation, successful rendering and a new PDF/zoom generation. Neither the component nor the renderer observes changes to the scrolling viewport's dimensions. After all initial renders settle, increasing its height without changing scroll position can expose additional placeholders outside the old neighbor window. Those pages stay blank until another scroll/navigation/zoom/build happens. Maximizing a short window while reading at 50% is one reachable trigger; the page counter also continues to reflect the old viewport.

**Selective evidence:** A deterministic layout probe loaded a ten-page document at 50% in a 300 CSS px viewport. Pages 1 and 2 rendered. Increasing `clientHeight` to 1000 and dispatching window resize exposed page 3, but the rendered set remained `[1, 2]`. Calling the existing `renderer.update()` immediately rendered page 3, proving the missing invalidation rather than a bad page/load. The desired-behavior assertion fails with `expected [ 1, 2 ] to include 3`.

**Correction:** Observe the actual scroller size with a lifecycle-owned ResizeObserver and refresh the render window when it changes. Disconnect on teardown. Add a regression that changes the viewport height after all renders settle and checks newly visible pages without generating a scroll event.

### P2: Consecutive zoom/new-output generations lose the reading anchor while loading

**Location:** `apps/web/src/lib/pdf-renderer.ts:45-50`, in combination with `anchor()` at lines 33-38 and restoration at line 75.

Each `show()` captures the reading anchor from the current generation's wrappers and immediately replaces that generation with an empty one. If another zoom click or PDF replacement arrives before the first replacement finishes loading, the next `show()` reads the empty wrapper list and captures page 1, fraction 0. Its eventual successful output then moves the reader to the start of the document. This is a race in ordinary rapid zoom interaction, especially with a large document or a slower PDF worker. Existing tests await each complete `show()` before changing zoom, so they do not exercise it.

**Selective evidence:** A deferred-load probe positioned a 100-page PDF at page 50, 40% down. It began a 110% replacement, then began a 120% replacement before the former document resolved. Resolving the latest replacement returned the scroll anchor to page 1. The assertion that the page-50 normalized offset remains 0.4 failed with actual `-49.81666666666667` relative to page 50. The superseded loading task was then resolved and all renderers closed for cleanup.

**Correction:** Retain the last meaningful displayed/pending anchor independently of an empty loading generation, and carry it through successive replacements until the latest generation can restore it. Keep any intentional forward-search target able to supersede that anchor. Add a deferred overlapping-show regression rather than only sequential zoom tests.

## Probe reproduction

The two focused desired-behavior probes are preserved in `docs/evidence/authoring/review-workspace-probes.vitest.txt`, outside normal test discovery. They reuse the existing PDF renderer test's fake-layout/deferred-task helpers. To reproduce the original findings on the pre-fix implementation, copy that file to `apps/web/test/review-workspace-probe.test.ts`, run:

```powershell
pnpm --filter @hivetex/web exec vitest run test/review-workspace-probe.test.ts
```

Then remove only the copied test. Final probe run: **1 file / 2 tests failed as expected**, 3.07 s. The temporary discovered test was removed after the run. The first finding was also reproduced independently before adding the second probe. These were controlled unit/layout reproductions plus component wiring inspection. The historical resize probe has no ResizeObserver shim and is not a post-fix gate; use the permanent renderer regressions to validate the corrected observer path.

## Scope and checks by inspection

- Read the OpenSpec design/tasks and authoring acceptance document as context, not proof of correctness.
- Read `LocalCompiler`, failure/pipeline changes and scheduler tests: automatic/manual/periodic transitions, maximum debounce wait, one running plus one pending request, explicit request promotion, failed-attempt invalidation, input acquisition and stop/timer/subscription ownership. No additional actionable defect was established in that scope.
- Read the source-sequence PDF acceptance/stale-check changes and revision tests: capture metadata, updates during compilation, delayed SyncTeX parsing, a later failed build retaining the accepted PDF/map, engine revision checks and close guards. No additional confirmed race was established there.
- Read PDF loading/rendering generation ownership, cancellation, eviction, page placeholders, anchor restoration, PdfView highlight/reverse-search wiring, close behavior and focused renderer/revision tests. The two findings above concern previously untested integration/race edges.
- Read Editor/editor-theme changes and selection/undo insertion boundaries; inspected toolbar measurement/overflow, MenuList scrolling, CompilePreferences, Account/Workspace/palette integration, ProblemsPanel and StatusBar. No confirmed source-loss, undo regression or additional accessibility defect was established by this selective inspection.
- Read the sync model/snapshot availability changes and acquisition/hash boundaries, including the availability API's use by projected/worker-backed models. Snapshot text/settings are synchronously captured before binary fetches; no additional actionable defect was established in the small delta.

## Residual gaps and usage status

No full test suites or native/compiler gates were repeated. The focused PDF browser journey was extended and rerun as recorded above. No Linux/macOS WebViews, assistive-technology interaction, arbitrary oversized PDF pixel-memory stress or end-to-end worker-backed edit/snapshot scenario was executed during this selective review. Existing functional and acceptance results remain separate evidence; this review does not certify those unexecuted cases.

The earlier review turn was interrupted by a usage limit whose supplied reset was 05:18. Work resumed after the coordinator reported 06:22:56 UTC on 2026-10-24. No new usage/reset metadata was returned by tools during the resumed probes. No quota amount is inferred.

Both findings are resolved by the follow-up above. Final production-distribution acceptance/report consolidation remains a separate serialized pass.