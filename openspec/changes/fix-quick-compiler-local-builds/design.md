# Design

## Context

See proposal.md - Why. Relevant current code (`apps/web/src/lib/session.svelte.ts`):

- `policy()` already derives the **effective** mode: `peers` stays `peers`; otherwise `localOnlyCompiler` (set when the
  native engine or desktop helper reports `verifiedReads === false`, i.e. Tectonic) forces `local`; else the stored
  `compileMode`. Election opt-out, `autoLocal` and `acceptRemote` come from it, so the election is correct: a
  quick-compiler device never leads.
- Consumers outside `policy()` still read the stored preference or leadership:
  - `StatusBar.svelte` branches on `s.compileMode === 'local'`, then `s.leaderName`, else "Compiler: none available".
    With Tectonic under *Automatic*, `compileMode` is `auto` and `leaderName` is null (nobody eligible), so it prints
    "none available" while the `compiler-state` item next to it says "quick compiler (builds stay on this device)".
  - `requestCompile()`: leader → `leader.run()`; otherwise broadcast `compile-request`; and `compileLocal()` only when
    `mesh.peers.length === 0`. With a co-author online and nobody leading, the request goes nowhere. When alone *and*
    leader, it runs both `leader.run()` and `compileLocal()` (two builds of the same state).
  - `scheduleLocalCompile()` is called only from `onDocUpdate` and `setCompileMode`; `setupCompile()` and
    `installQuickCompiler()` (engine adopted while the project is open) never schedule one, so a local-policy device
    shows no PDF until the first edit.
- `CompileClient.requestCompile()` just broadcasts; the leader is the only responder.

## Goals / Non-Goals

**Goals:**
- One source of truth for "how this device takes part" (effective mode), used by the status bar and by compile triggers.
- A local-policy device always produces its own PDF: on open, when its compiler becomes available, after edits, and on
  explicit request, whatever the number of connected peers.
- An explicit request never goes unanswered when this device can compile.

**Non-Goals:**
- Changing the election, scoring, or the rule that unverified-read builds are never shared.
- Changing the Rust detection / `verified_reads` semantics or the quick-compiler download flow.
- Changing the stored preference when a local-only compiler is detected (the select keeps showing the user's choice).

## Decisions

**D1. Expose the effective mode from the session.** Add `effectiveCompileMode` (getter/`$derived`, same expression as
today's `policy()` input) and make `policy()` use it. `StatusBar` reads `s.effectiveCompileMode` instead of
`s.compileMode` for the "who compiles" item. Alternative considered: rewriting `compileMode` to `local` when the quick
compiler is detected — rejected, it would persist a choice the user never made and stick after installing full LaTeX.

**D2. A pure compile-target decision.** Add to `compile-mode.ts`:
`compileTargets({ amLeader, leaderExists, autoLocal, hasEngine }) → { runLeader, request, local }`:
- `autoLocal` (effective local) → `local` only (no broadcast: this device does not show remote results, and the
  existing *This device only* spec says co-authors are unaffected);
- `amLeader` → `runLeader` only (removes the duplicate local build when alone);
- a remote leader exists → `request` only;
- nobody leads → `request` (a device may become leader meanwhile) plus `local` when `hasEngine`.
`requestCompile()` applies it. Pure → unit-testable without a mesh. Alternative: patching the `peers.length === 0`
condition inline — rejected, the cases above are exactly what was wrong and deserve a tested table.

**D3. Compile on readiness.** At the end of `setupCompile()` (after `election.start()`), and in
`installQuickCompiler()` when the engine is adopted while the project is open, call `scheduleLocalCompile(0)`. It is
already a no-op unless `policy().autoLocal` and an engine exist, so *Automatic* devices with verified compilers keep
today's behavior (the leader builds).

**D4. Status text from effective mode and compiler phase.** Order: effective `local` → "Compiles only on this device"
(+ " (quick compiler)" when `localOnlyCompiler` and the stored mode is not `local`, so the user understands why);
leader known → current text; `compilerPhase` is `setting-up` → "Setting up the compiler…"; else
"Compiler: none available". Keep `data-testid="leader"` on every branch so existing e2e assertions keep working.

**D5. Quick-compiler time limit counts compiling, not downloading.** `run_limited_io` kills the build when wall-clock
time exceeds `timeout_ms` (120 s from the pipeline). Tectonic's first build downloads its whole support set and can
exceed that on an ordinary connection (observed ~145 s in Windows Sandbox; a user saw "Compile timed out after 120 s").
The `note: downloading` watcher in `compile_tectonic` already sees each download: it now always runs (not only when the
UI listens) and records the time of the last download in a shared atomic. `run_limited_io` takes that optional
activity marker and stops the build when `now - max(start, last download) > timeout` or `now - start > cap`
(cap: 15 min). The decision is a pure function, unit-tested. Alternatives: a larger fixed timeout for Tectonic —
rejected, it also delays stopping a genuinely stuck build by the same amount; pre-warming the bundle at install — larger
change, and documents still fetch packages later.

## Risks / Trade-offs

- [Removing the alone-and-leader local build changes when `this.pdf` updates] → the session's `CompileClient` already
  receives the own leader's results (`leader` passed to it); a task verifies the PDF still appears when compiling alone.
- [Nobody-leads case builds locally and also broadcasts] → if a device becomes leader in between, two builds may run
  once; acceptable, and the local result is replaced by the leader's when it arrives (`acceptRemote`).
- [Compile on open costs a build on every project open for local-policy devices] → intended per spec; the build is
  skipped by the pipeline only if it already dedupes identical states, otherwise it is one build per open.
- [Root cause on the reporting user's machine not confirmed] → task 1.1 checks the status bar's compiler item; if it
  does not say "quick compiler", the cause is elsewhere (download failure / no engine) and this change is still valid
  but not the fix for that report.
  **Confirmed (2026-10-13):** the reporting user's status bar shows Compile: *Automatic* and
  "quick compiler (builds stay on this device)" next to "Compiler: none available", the exact path described above.
