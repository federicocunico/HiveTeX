# Proposal

## Why

HiveTeX's collaborative workspace needs dependable editing and compilation before further visual polish: users report line-number problems and unreliable builds, while current tests do not cover several rendering failures. Oleafly provides concrete references for workspace hierarchy and behavioral tests that can be adapted to HiveTeX's Svelte, CodeMirror and local compilation architecture.

## What Changes

- Fix editor geometry, gutter alignment, scrolling and selection regressions with browser and native acceptance checks.
- Make existing automatic compilation reliable and visible; offer After changes, Periodic and Manual scheduling, explicit progress and recovery, and tests using real LaTeX rather than only the fake engine.
- Keep PDF rendering, navigation and SyncTeX tied to the displayed build; prevent obsolete rendering jobs from affecting a newer preview and bound work for long PDFs.
- Align the workspace with Oleafly's restrained surfaces, compact controls, clear pane hierarchy and accessible overflow menus, preserving HiveTeX's identity and collaboration model.
- Resolve the stale workspace specification describing peer build leaders; expose local engine and scheduling separately from synchronization.
- Turn the audit's editor, build and layout acceptance cases into required CI checks; reproduce the reported desktop duplicate-instance issue using the existing lifecycle harness and fix it if confirmed on the current build.

## Capabilities

### New Capabilities

None. These changes extend existing workspace capabilities.

### Modified Capabilities

- `latex-workspace`: measurable editor geometry and responsive, revision-safe PDF rendering.
- `local-compilation`: explicit scheduling modes, bounded retries and actionable build outcomes.
- `workspace-layout`: coherent control hierarchy, reachable overflow actions and truthful local compilation status.
- `interface-preferences`: persisted device-local scheduling preferences.

## Impact

Primary code: `apps/web/src/components/Editor.svelte`, `PdfView.svelte`, workspace components, `views/Workspace.svelte`, styles, preferences and session wiring; `packages/compile/src/local.ts`; browser/native compiler adapters where a reproduction identifies a defect. Tests: existing Vitest, Playwright and desktop harnesses, `.github/workflows/ci.yml` and desktop acceptance jobs. No framework migration or sync-protocol change is proposed.

The evidence, priorities, upstream permalinks and limitations are in [audit.md](audit.md). Implementation order is P0 compilation and editor regressions, P1 preview/layout and desktop lifecycle verification, then visual refinement and regression gates. AI features, Typst, cloud collaboration, multi-tab editing and a rebrand are outside this change.
