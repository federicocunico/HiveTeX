# Tasks

## 1. Durable local initialization

- [x] 1.1 Persist reliable local initialization evidence with root completeness and restore it on reopen; add availability/runtime regression tests covering saved/reopened local roots, evidence-backed recovery and an incomplete joined replica that must stay incomplete.
- [x] 1.2 Wire create-from-folder and all source-creation paths into local initialization, await durable import completion, and propagate completeness through native actor/renderer acquisition and restart; verify import and worker regressions including a failed save and automatic retry when inputs become ready.

## 2. Home ZIP creation

- [x] 2.1 Add Import ZIP to the projects home header, empty and local-mode states, preselect the ZIP in creation with editable suggested name, and reuse the existing importer/main-file preview; verify picker cancellation, no template mixing, local mode and ambiguous roots in UI tests; document the entry point in docs/import.md.

## 3. Accurate input recovery

- [x] 3.1 Preserve structured missing-content causes in compiler failures and offer applicable retry/import restoration or synchronization; add compile and ProblemsPanel tests distinguishing unreadable storage, unknown root, missing remote content and real TeX/dependency errors, preserving the last good PDF.

## 4. Integration acceptance

- [x] 4.1 Run targeted import, availability, snapshot, local compilation and native worker checks, plus home-ZIP/reopen/source-sharing end-to-end coverage; verify type/build checks for affected packages and record outcomes.
- [x] 4.2 Validate both supplied ZIPs and folders read-only using the real parser, local persistence/reopen and zero-peer input acquisition, and verify later peer source delivery; exercise an available real local compiler in isolated temporary folders and record PDFs or exact source/package incompatibilities separately from input readiness in an acceptance report.
