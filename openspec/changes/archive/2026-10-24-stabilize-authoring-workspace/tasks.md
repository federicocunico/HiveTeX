# Tasks

Audit IDs refer to [audit.md](audit.md). Implement groups 1–3 before preview/visual refinement; each group includes its own tests and documentation. No implementation has been performed by the proposal workflow.

## 1. Editor geometry and interaction (P0, A01)

- [x] 1.1 Add a deterministic 6200-line manuscript and LF/CRLF variants plus a browser geometry probe that matches visible numbers to logical source lines and excludes hidden spacers; verify the probe detects a deliberately perturbed gutter and report the current-build reproduction with screenshots/computed metrics.
- [x] 1.2 Correct the reproduced font/line-height/wrapping/measurement defect in `Editor.svelte` and `styles/editor-theme.ts`; verify <=1.5 CSS px settled alignment at 11/14/18/24 px, distant scroll, font readiness and pane resize with no blank viewport or application scroll leak. If the reported defect is already absent, document the evidence and retain the regression contract rather than applying an unexplained offset.
- [x] 1.3 Extend the existing editor/presence browser journeys for remote insert/delete above the viewport, selection/copy, undo/redo and file rebinding; verify logical cursor position, exact source restoration and no gutter text in copied source, and document reproduction commands in `docs/testing.md`.

## 2. Real compilation and recoverable failures (P0, A03, A07)

- [x] 2.1 Extend real compiler fixtures with the shipped article and multi-file report, bibliography and image; run browser/native/helper paths with fake engines disabled and record the first failing stage, engine/format/package versions and logs in an acceptance report. Verify PDF text and resolved bibliography/reference output, not merely canvas existence.
- [x] 2.2 Resolve the observed WASM format/package incompatibility using a coherent versioned resource set; record selected revisions/checksums and cache identity, and verify article/report on cold setup, warm cache and offline reopen without mixing incompatible cached resources.
- [x] 2.3 Fix any native/helper failure exposed by 2.1 in its existing adapter, preserving timeouts and process cleanup; verify the same real templates, package acquisition failure, explicit retry and offline cached build. Record an explicit passing reproduction if a path needs no code change.
- [x] 2.4 Expose structured failure/setup causes through session state and `ProblemsPanel.svelte`; verify missing compiler, unsupported engine, missing asset, package failure and source error all present an actionable summary, never "No problems" while blocked, and preserve the last good PDF. Update compiler troubleshooting documentation with verified recovery steps.

## 3. Compilation scheduling and preferences (P0, A02)

- [x] 3.1 Add validated device-local schedule and interval fields to `preferences.svelte.ts`; verify absent/corrupt values, integer/range validation, restart, storage-event propagation and independent co-author preferences, with no shared/local-mode migration regression.
- [x] 3.2 Consolidate automatic scheduling in `packages/compile/src/local.ts` and remove duplicate session edit scheduling while preserving stale/history updates; verify 1500 ms debounce, 5000 ms maximum wait, periodic dirty checks, initial ready inputs and Manual suppressing open/edit-triggered builds using deterministic clock tests.
- [x] 3.3 Bound execution to one running job and one pending request; verify bursty explicit requests, edits during acquisition/build, periodic ticks during execution, successful hash reuse, engine/settings changes and Manual transitions without overlapping engine calls.
- [x] 3.4 Add failed-attempt suppression and explicit recovery invalidation; verify unchanged syntax failures are not retried on every tick, source/dependency/engine changes permit retry, newly received assets recover, and close/stop removes all timers and prevents builds from background seeds.
- [x] 3.5 Wire scheduling and interval controls into the compile menu, Account preferences and command-palette access with visible waiting/running/blocked state; verify keyboard activation and retained editor selection, plus a browser journey where an edit updates the PDF automatically and Manual requires an explicit request. Document the defaults, interval limits and local execution behavior.

## 4. Preview consistency and responsiveness (P1, A04, A05)

- [x] 4.1 Associate each accepted PDF with its own source revision/watermark, engine and SyncTeX lifecycle; verify delayed parsing, A completing after edit B, failed later builds and pending-edit counts never pair a new PDF with an old mapping or claim it is current incorrectly.
- [x] 4.2 Refactor `PdfView.svelte` task ownership and cleanup by generation; use controlled loading/render promises to verify old success, old failure, zoom races and project closure cannot mutate the active preview and discarded tasks/documents are released.
- [x] 4.3 Prioritize visible PDF pages with placeholders, bounded neighboring-page rendering and canvas eviction; verify a 100-page PDF shows page 50 before all pages render and canvas/resource counts remain bounded during distant scrolling and ten open/close cycles.
- [x] 4.4 Preserve page-relative reading location across zoom/new output and maintain correct coordinate transforms; verify forward/reverse SyncTeX, missing-map disabled navigation, failed-build preservation and uninterrupted source focus. Document preview/stale-state behavior and the long-PDF test command.

## 5. Workspace layout and visual alignment (P1/P2, A06, A08, A11)

- [x] 5.1 Replace hidden-scrollbar-only formatting overflow with a measured, labeled menu using existing UI primitives; verify keyboard reachability, selection-preserving insertion, resize restoration, stable action order and no duplicate actions.
- [x] 5.2 Refine the status bar into concise separate save/sync/build summaries with accessible details; verify critical save/build warnings remain reachable at narrow widths, synced sources can coexist with a stale PDF, and no peer-build-leader wording remains in current UI/help.
- [x] 5.3 Refine tokens and pane/header/toolbar styling against the pinned Oleafly reference while preserving HiveTeX branding; deliver a screenshot contact sheet for light/dark at 1440x900, 1280x800 and 1024x768 using a real compiled article, long names and ready/loading/error/stale/offline/collaborating states. Verify 125%/150% zoom/text enlargement and existing four-action/focus-mode contracts.
- [x] 5.4 Add reviewed visual baselines on a pinned browser/font runner plus geometry/focus and axe checks for workspace and affected preference/menu surfaces; verify both themes, toolbar overflow, dialog focus return and serious/critical accessibility failures. Update screenshot generation to require real LaTeX for product/documentation captures and document baseline review instructions.

## 6. Desktop lifecycle and native acceptance (P1, A09)

- [x] 6.1 Extend the existing isolated desktop lifecycle acceptance to repeated/concurrent/cross-path launches, close-to-tray/reopen and compiler setup/builds; record owner PIDs, worker ancestry, identifiers and tray/window counts. Verify one owning app/tray entry per profile and explicitly distinguish normal compiler workers and separate E2E identity.
- [x] 6.2 Correct the launch/lifecycle path if 6.1 reproduces duplicate instances; verify the same scenario before/after and rerun background seeding, browser pairing and hidden-process/focus tests. If already fixed, deliver current packaged evidence and retain the regression, without an unrelated refactor.
- [x] 6.3 Adapt editor geometry, automatic build and preview smoke checks to the existing native harness; verify Windows WebView2 and supported macOS/Linux webviews in their acceptance environments, recording platform skips as missing acceptance rather than passes. Update `docs/testing.md` and the existing `docs/windows-maintenance.md` acceptance record with the build/version and results.

## 7. Required checks and integrated acceptance (A10)

- [x] 7.1 Add the focused editor/scheduling/layout suite to required CI with zero retries, keeping unrelated browser diagnostics advisory; update `ci-browser-policy.test.ts` and verify deliberate failures cannot yield a passing required job. Publish traces/screenshots/logs on failure and document exact commands in `docs/testing.md`.
- [x] 7.2 Make real browser/native template compilation an explicit required acceptance lane with pinned prerequisites and no silent engine skips; verify first-time setup and cached execution from a clean checkout and report the engine/version used by each lane.
- [x] 7.3 Run the integrated stress journey with the long manuscript, PDF, two collaborators, offline/reconnect, theme/size changes and correction of a compile error; verify convergence, exact undo restoration, <=1.5 px gutter tolerance, no blank surfaces and recorded interaction p95 within the design's documented reference-runner budget.
- [x] 7.4 Complete a finding-to-test closure table for A01–A11, run relevant existing sync/history/access/local-compilation regression gates and strict OpenSpec validation, and attach the reviewed visual/native evidence. Verify every finding is fixed or explicitly explained with current evidence; no reported defect is silently marked resolved by a fake-engine test.

## Workflow follow-up

- Review the implementation and acceptance evidence before archiving this change.
- For any authorized push, identify and monitor its triggered CI/build/deploy workflows to a terminal result; diagnose and fix failures before reporting completion.
