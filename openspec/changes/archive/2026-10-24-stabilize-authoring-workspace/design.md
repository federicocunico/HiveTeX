# Design

## Context

See [proposal.md](proposal.md) for motivation and [audit.md](audit.md) for A01–A11 evidence and upstream permalinks. HiveTeX uses Svelte 5, CodeMirror 6/Yjs, a local compiler service and PDF.js across web and Tauri. Its current service already debounces and coalesces; its UI lacks scheduling controls. Existing service tests (12) and workspace/theme browser tests (15) pass, so they must be supplemented with tests that expose the reported failure modes.

Two constraints drive the design: preserve the editor's document/undo binding during presentation changes, and keep generated results local. The old `workspace-layout` peer-compiler wording conflicts with `local-compilation`; the delta explicitly reconciles it. The existing 1100 px narrow-layout and four-header-action contracts remain in force.

## Goals / Non-Goals

**Goals:** Give each rendered surface one clear revision/owner; make build scheduling deterministic; validate real user flows across browser and desktop; keep important controls usable at constrained sizes. Every audit finding must end with a regression check, a documented current-build reproduction result or an explicit unresolved issue.

**Non-Goals:** Replace Svelte, CodeMirror, PDF.js or Yjs; add Oleafly's collaboration server, AI, visual editor or tabs; change the source format or privacy model. The duplicate-tray report is a focused verification of existing lifecycle behavior, not a new process architecture.

## Decisions

### 1. Measure editor geometry before changing it (A01)

Extend the current browser suite with a deterministic manuscript fixture (6200 lines, varied lengths, equations, bibliography references, blank lines, Unicode and a CRLF variant). Use a test-only accessor to the active EditorView if needed; expose nothing in production builds. Match each visible numeric gutter to its logical source position through CodeMirror, excluding hidden spacer nodes and buffered offscreen rows. Poll a bounded settling condition after resize/font readiness and assert <=1.5 CSS px discrepancy, no blank viewport and no outer-document scrolling.

Keep font family, size and line height consistent across content and gutters; inspect computed style and CodeMirror measurement invalidation under font loading and resize. Update metrics/re-measurement only where the reproduction identifies an issue. Preserve selection, scroll anchor, undo and the mounted editor when preferences change. Cover local/remote edits and document rebinding with existing tests.

Alternative considered: fixed gutter offsets or remounting on every resize. They mask one screenshot while breaking wrapping, font changes or collaboration. Copying Oleafly's theme wholesale would also import unrelated CSS and features.

### 2. One scheduler with independent execution and policy (A02)

`LocalCompiler` owns scheduling. `ProjectSession` owns engine availability and UI state; remove its duplicate edit-trigger scheduling once equivalent stale/history behavior is preserved. Pass a validated policy into the compiler and explicitly notify it when preferences change.

Policy is `after-changes | periodic | manual`, separate from the existing `CompileMode = local` migration. Default `after-changes`: 1500 ms debounce, 5000 ms max wait. Periodic defaults to 30 seconds, accepts integer 5–300 seconds, and checks dirty state on each foreground interval. No compiler work occurs for background-only seeds. Initial ready input and compiler changes count as invalidation in automatic modes; Manual requires an explicit request, including on project open. Switching from Manual to an automatic mode schedules dirty inputs according to that mode.

Maintain one running job and one pending invalidation, not an unbounded list of `run()` waiters. Capture a complete input snapshot only when the job starts. When it finishes, compare against latest relevant input state and schedule at most one follow-up. Manual requests bypass debounce but share the same execution queue. Changing to Manual cancels automatic timers/pending requests while allowing a running job to settle. Closing cancels everything via existing abort/stop plumbing.

Deduplicate successful builds by input hash plus engine revision. Remember failed attempts with an input/environment/dependency-availability fingerprint to prevent periodic retry storms. Explicit Retry, new source/settings/assets, dependency arrival and recovered engine state invalidate the failed-attempt suppression. Do not retry unavailable packages solely because another clock tick arrived.

Alternative considered: a UI `setInterval(compileNow)` loop. It would run while unchanged, duplicate existing scheduling and conflate retry with automatic policy. The policy belongs at the existing compiler boundary.

### 3. Real compilation is a separate acceptance lane (A03, A07)

Use existing `e2e/local-real-compile.spec.ts`, `tex-fixture.ts`, native compile tests and paired-helper harness. Add the shipped article/report with a deterministic bibliography and image; assert actual typeset text and resolved references, then edit, fail, recover and reopen offline. Ensure `hivetex.fakeEngine` is absent and a real engine path ran. This complements deterministic UI tests which may continue to use a fake engine.

For the browser engine, record format/kernel/package versions and replay the documented 2020-format/current-package incompatibility. Provision a coherent pinned format-and-package distribution for the supported fixture set; update the format and matching resources together if pinning the existing set cannot support the product templates. Keep checksums, compatible licenses, cache versioning and package provenance. Never mix cached packages from incompatible distributions. Implement versioned cache selection without deleting unrelated source stores, and retain a recoverable offline path.

Native and helper builds must run the same fixtures using their supported engine, with setup, timeout, package failure and retry behavior surfaced through the current adapters. Use typed build-state/reason data so `ProblemsPanel` does not need to infer environment failure from empty diagnostics. A failure with no line displays its meaningful cause immediately, while Raw log remains secondary. Do not mark an absent compiler as "No problems".

Alternative considered: treating the existing minimal-class WASM smoke or a fake PDF canvas as template acceptance. Those checks cannot detect class/package incompatibility or failed bibliography passes.

### 4. Own the preview by build and render generation (A04, A05)

Represent an accepted local preview as a coherent bundle: build id, source state hash/snapshot watermark, PDF bytes, optional matching SyncTeX and engine description. If mapping preparation is asynchronous, clear/disable jumps for the new preview until its own map arrives. Old successful output and its map survive a later compile failure together. Pending edits compare against the captured source watermark/hash, never the wall-clock time at completion. If an exact edit count is unavailable, show truthful "Outdated" wording rather than zero pending edits.

In `PdfView`, keep PDF.js loading tasks, documents and page render tasks scoped to a generation. Superseding a generation cancels its tasks; its resolve/reject/finally paths cannot mutate current UI state. Destroy discarded documents even if their load finishes late. Loading errors, rendering errors and cancelled work have distinct handling.

Create page placeholders with dimensions, prioritize visible pages, prefetch a small neighbor window and evict distant canvases under a bounded pixel/page budget. Preserve the reading anchor (page and normalized within-page position) across new PDFs and zoom. Native/browser input remains interactive. Keep last displayed pages until replacements are ready where possible. Maintain SyncTeX coordinate transforms against the displayed generation/zoom.

Alternative considered: retain all-page serial rendering and add a spinner. That leaves long-PDF latency, memory growth and obsolete-job races unresolved. A different PDF library is unnecessary for these ownership and scheduling fixes.

### 5. Refine the existing workspace hierarchy (A06, A08, A11)

Use existing tokens, menus, icon buttons, splitter and focus helpers. Tighten the gutter and neutral surfaces after functional geometry is stable; maintain 11–24 px editor preferences, accessible contrast and the honey identity. Create review screenshots using a real article and the shared state matrix in `audit.md`.

Keep four header actions plus More. Put scheduling controls beside Recompile and expose the same preferences through Account and the palette. Display short local build state separately from sync/save state. Move verbose compiler/package details into accessible expandable status. A critical error or saving warning remains visible; it must not disappear in an overflow menu.

Use measured overflow for formatting controls, retaining stable order and selection across menu interaction. Keyboard navigation, Escape and restored focus must work. At 1024 px retain the Editor/PDF toggle and overlay sidebar. Validate 125%/150% text/zoom with long names, as well as panes narrowed independently of overall window width. Do not transplant Oleafly's large header action count or introduce their additional feature surfaces.

Alternative considered: only change colors/fonts. That would leave hidden commands and ambiguous build state, which are the more consequential usability problems.

### 6. Adapt test scenarios to our harnesses (A09, A10)

Reuse Vitest for scheduler transition/fake-clock tests and controlled renderer races. Use real-browser geometry and user interaction for layout, selections and overflow. Use actual compiler lanes for generated content. Reuse our isolated native harness rather than importing Oleafly's React/Zustand fixtures, sequential shared state or Tauri socket bridge.

Run current duplicate-instance scenarios through `apps/desktop/e2e/lifecycle.mjs` and the packaged installer identity: repeated/concurrent launches, same binary at another path, close-to-tray/reopen, compiler detection/build/package download. Record app-owner PID and process path, worker ancestry, tray/window count and profile identifier. An E2E app and installed app deliberately use different identifiers; do not label their coexistence a defect. If current code already resolves the report, record evidence and retain the regression check; do not invent a single-instance fix.

Promote only the focused editor/scheduler/layout and real compilation checks to required CI, with zero retries for the deterministic core. Keep failure traces, screenshot diffs and compiler logs. Update `ci-browser-policy.test.ts` together with the workflow policy; do not make all advisory diagnostics blocking by accident. Native acceptance must report skipped platforms explicitly; Chromium alone is not Tauri acceptance. Visual baselines run on a pinned runner/font environment; geometric assertions remain the primary gutter check.

For the long manuscript, measure input-to-paint/scroll latency with warm-up and p95 reporting while PDF rendering runs. Use a 100 ms p95 local interaction target and fail the dedicated stress gate on >250 ms p95 on the documented reference runner; retain raw samples and environment. Do not add unstable cross-machine timing limits to every functional test.

## Risks / Trade-offs

- **Browser/native font metrics differ** → Test logical-line geometry with bounded tolerance and native smoke; avoid CSS magic numbers.
- **Automatic compilation consumes CPU while typing** → Debounce, max wait, single pending job, unchanged-input reuse and explicit Manual/Periodic modes.
- **Periodic retries amplify package outages** → Failed-attempt fingerprint and recovery signals; never retry indefinitely on a timer.
- **PDF virtualization changes navigation** → Preserve page placeholders/anchors and exercise first/last/distant pages plus forward/reverse SyncTeX under zoom.
- **WASM distribution compatibility changes cached offline behavior** → Version formats and resources as a set, validate upgrade/offline/retry and preserve the previous usable cache until replacement is ready.
- **User-reported gutter/tray failures may be version-specific** → Record current reproduction and conditions; do not claim a fix without an observed failure or explicit already-fixed evidence.
- **Upstream tests depend on other architecture** → Adapt assertions and fixtures with attribution where code is reused; review upstream license before any code copying.

## Migration Plan

1. Add reproductions and the focused acceptance fixtures; establish failures before changing the associated implementation.
2. Deliver editor/build correctness, then coherent preview state, then visual/overflow changes. Preserve existing history, synchronization and access tests at each step.
3. Add scheduling fields to the existing device-local preferences parser. Missing/invalid fields select After changes and 30 seconds; legacy shared/local values keep their existing migration and are never reinterpreted as schedules.
4. If compiler resources change, introduce a versioned cache and compatibility manifest as one release unit. Verify warm/cold/offline startup and actual article/report output.
5. Review screenshots in both themes and approve focused CI/native results before shipping. Any authorized push must be followed through the triggered workflows to a terminal green result under repository instructions.
6. Rollback UI/scheduling code without touching project sources or Yjs stores; older readers ignore new preference fields. Roll back the compiler manifest/resource set together and retain the last usable local distribution.

## Open Questions

- Which concrete runtime condition causes the reported gutter problem and duplicate tray entries on the user's installed build? The specified reproduction matrix can answer this without changing the behavior contract or architecture.
- Which pinned WASM format/package revision supports all declared template fixtures with the smallest compatible resource update? The compatibility acceptance contract is fixed; record the selected revision and checksums during the scoped compiler work.
