# Acceptance results

Validated against the v0.10.0 checkout on Windows, 2026-10-28. Changes have not been released or installed into the running 0.10.0 application.

## Automated checks

- Sync availability, runtime, snapshot, editor bridge and packaged worker: 41 tests passed across 5 files. Includes native worker restart and imported-batch availability.
- Import, home ZIP UI in signed-in/local modes, creation evidence, legacy restoration and ProblemsPanel: 45 tests passed across 5 files.
- Compiler failures and local scheduling/capture: 21 tests passed across 2 files, including missing input handling and preservation of the last successful PDF.
- Browser import/folder integration: 6 Playwright tests passed. Home picker cancellation, ZIP creation, zero-peer build-input readiness, reopen, later co-author delivery, read-only viewers and existing import behavior are covered. These integration builds use the test engine; they do not demonstrate real TeX output.
- Sync and compile TypeScript builds passed; web production build passed. Existing unrelated Svelte accessibility/state and chunk warnings remain.
- OpenSpec strict validation and `git diff --check` passed.

## Private project fixtures

Command: `pnpm exec tsx scripts/check-import-fixtures.mts <fixture-directory> .data/import-acceptance/inputs.json --compile`.

The original ZIPs and folders were read without modification. The check uses the production import and capture code, the browser persistence adapter with an isolated IndexedDB test backend, and authenticated encrypted loopback peers. It closes and reopens the persistence connection before repeating capture. This does not substitute for operating two packaged desktop installations over a real TURN server.

| Sample | Source files | ZIP/folder equivalence | Capture with zero peers | Reopen | Later peer delivery |
| --- | ---: | --- | --- | --- | --- |
| Nature Reviews | 16 (7 text, 9 binary) | Identical content/settings hash | Pass | Pass | Pass |
| JBHI | 51 (16 text, 35 binary) | Identical content/settings hash | Pass | Pass | Pass |

Nature selects `main.tex`. JBHI identifies several root documents and correctly requires main-file confirmation; the real compiler check used its suggested `main_JBHI.tex`.

## Real compiler checks

Inputs were written from the immutable imported capture into separate temporary directories. MiKTeX's package installer and shell escape were disabled; the original sources were not edited.

- **Nature Reviews:** PDF produced successfully (2,152,968 bytes), with successful pdfLaTeX, BibTeX and two further pdfLaTeX passes.
- **JBHI:** inputs reached pdfLaTeX successfully, but the installed distribution lacks `bbm.sty`. The first pass stops with `LaTeX Error: File 'bbm.sty' not found`; no PDF was produced. This is a compiler dependency failure, not an unavailable project/file-list or peer-connection failure. No packages were installed or source files altered to hide it.

Raw local results and temporary compiler paths are recorded in `.data/import-acceptance/inputs.json` (ignored by Git).
