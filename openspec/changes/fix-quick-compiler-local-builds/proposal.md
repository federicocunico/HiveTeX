# Proposal

## Why

A user on a fresh desktop install (no TeX on the computer) reports that documents do not compile and the status bar
reads "Compiler: none available". Reading the compile wiring shows why: the quick compiler (Tectonic) set up
automatically on such an install cannot verify its file reads, so the session silently switches that device to the
*This device only* policy (never leader, never shares). The status bar and the compile triggers still reason from the
user's stored preference (*Automatic*) and from leadership, so:

- the status bar finds no leader and says "Compiler: none available", although a compiler is installed and ready;
- nothing compiles when the project opens: the local build is scheduled only after an edit;
- the Compile button compiles locally only when nobody else is connected: with a co-author online it broadcasts a
  request to a leader that does not exist, and nothing happens.

The same gap hits any device with a working compiler that is not leader while nobody leads (e.g. *Automatic* with
"compile for others" off, next to co-authors who cannot compile). This contradicts the existing requirement that a
quick-compiler device "SHALL compile its own copy of the project automatically" and the *First compile without LaTeX*
scenario.

## What Changes

- The status bar reports the **effective** compile policy: a device whose compiler keeps builds local shows that it
  compiles on this device only (e.g. "Compiles only on this device (quick compiler)"), never "none available".
  "Compiler: none available" is shown only when no device, this one included, can compile; while the compiler is being
  set up the status says so instead.
- A device whose effective policy is local compiles once when the project is ready (and again when its compiler
  becomes available later, e.g. installed from Account > Compiler or after switching preference), not only after the
  first edit.
- The Compile button / command compiles on this device whenever this device's results are the ones shown (effective
  local policy) or nobody leads and this device has a compiler, regardless of how many co-authors are connected.
- Tests covering the quick-compiler (unverified reads) path, which today has none.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `compiler-provisioning`: *Quick-compiler builds stay on the device* gains scenarios for compiling on open, on
  explicit request with co-authors online, and for the status shown.
- `distributed-compilation`: *Automatic compilation* / *Local compile override* — an explicit compile request falls back
  to this device when no device leads and this device can compile; the workspace's "who compiles" indicator reflects
  the effective policy rather than the stored preference.

## Impact

- `apps/web/src/lib/session.svelte.ts`: effective-policy getter, `requestCompile`, initial local compile after
  `setupCompile` / `installQuickCompiler`, leader-name derivation.
- `apps/web/src/components/workspace/StatusBar.svelte`: leader / no-compiler text driven by the effective policy and
  compiler phase.
- `apps/web/src/lib/compile-mode.ts`: possibly a small pure helper (effective mode, compile-target decision) to test.
- Tests: `apps/web/test/compile-mode.test.ts` (unit), e2e `compile-modes.spec.ts` (local-only compiler scenario via the
  fake engine).
- No change to the election protocol, the Rust side, or what is shared with peers (quick-compiler builds stay local).

Assumption: the report concerns the desktop app on a computer without TeX (quick compiler auto-installed). The fix also
covers the web/desktop-helper case where the helper's compiler is unverified, which goes through the same
`localOnlyCompiler` flag. If the user's log shows the quick compiler download itself failed, that is a separate failure
already surfaced through `engineNote`; task 1.1 confirms which case applies.
