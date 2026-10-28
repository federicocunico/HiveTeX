# Design

## Context

See proposal.md for motivation. The checkout is tagged `v0.10.0`; archive parsing, import preview and application already exist. `Projects.svelte` hides the picker inside New project's existing-sources details and passes an in-memory pending import to the workspace.

`ProjectModel` deliberately distinguishes unknown/partial documents from complete ones. `ProjectRuntime.open()` marks the root complete for local-mode projects or `createdHere`. Normal creation calls `markCreatedHere`; `createFromFolder()` does not. Creating or importing text marks its text documents complete but does not prove completeness of an unknown root. `acquireProject()` therefore rejects that root as `(file list)`, even when every listed input is present. `failure.ts` then unconditionally tells users with missing inputs to reconnect to a co-author.

A read-only, in-memory probe used both actual ZIPs with the existing parser/model/mesh/acquisition code and zero peers:

| Sample | Files | Text / binary | Main selection | Acquisition without / with locally complete root |
| --- | ---: | --- | --- | --- |
| Nature Reviews | 16 | 7 / 9 | `main.tex`, unambiguous | `(file list)` / complete |
| JBHI | 51 | 16 / 35 | `main_JBHI.tex`, ambiguous; also R1, rebuttal and OLD roots | `(file list)` / complete |

Both persisted the corrected completeness across an in-memory store reopen. This demonstrates the model-level failure and recovery, not an end-to-end packaged desktop reproduction or successful TeX builds. Native worker projection has its own completeness cache and must be included in validation.

## Goals / Non-Goals

**Goals:** Reuse the importer; establish local initialization as durable evidence; keep build readiness independent from peer connectivity; repair affected stores only with reliable local evidence; preserve joined-replica safety.

**Non-Goals:** Replace the CRDT, infer completeness from owner role or nonempty text, upload sources to a server, execute archive build scripts, relax shell-escape restrictions, or rewrite the sample manuscripts to hide TeX errors.

## Decisions

### 1. A home action enters the existing creation flow

Add Import ZIP in the projects header and empty-state actions, with a user-gesture file picker. A selected ZIP opens New project with its source already set and a suggested editable name; cancelling the picker creates nothing. Reuse current creation metadata, local-mode behavior and ImportDialog. Preserve ambiguous main-file choice, notably for JBHI. Keep the existing archive/folder entry points. A separate importer or adding the ZIP as a binary would duplicate or bypass existing behavior.

### 2. Persist local root initialization, and recover only from evidence

Route all new-project creation paths, including create-from-folder, through the existing creation signal. Save a versioned local initialization record alongside root completeness, within the authoritative store, before reporting initialization durable. Persist source/asset writes before claiming successful import. On reopening, reliable initialization evidence can restore a lost root-completeness flag; a joined store, an owner role, an arbitrary bound folder or a newly added file cannot supply this evidence.

For affected older stores, inspect retained creation/catalog metadata and existing recorded local operations for trustworthy creation evidence. If evidence is absent, preserve the incomplete state and offer retry or explicit restoration from a complete ZIP/folder using the current import/recovery rules. Do not silently turn partial remote replicas into authoritative roots. Additive metadata keeps existing storage and sync formats compatible.

### 3. Local acquisition and native projection agree

Keep `Mesh.awaitComplete`'s immediate path for complete local state; load/recover locally held state before requesting absent remote data. Propagate initialized completeness through the authoritative native actor and renderer cache, including worker reattachment. Availability events and import completion must permit a blocked automatic build to retry. Avoid a second storage writer in the renderer or network reachability checks in local readiness.

### 4. Preserve structured missing-content causes

Carry the existing `MissingContent` kind/outcome through the local compiler to failure explanation rather than flattening it to names before classification. Treat `(project storage)`/unreadable outcomes as local storage failures. A root with unknown provenance should explain that local project initialization or restoration is needed, rather than assert that connecting a co-author is mandatory. Actual missing remote file bodies can offer Sync inputs; retain Retry and provide an applicable import/restore action. Preserve existing package/engine/source failures and the last good PDF.

### 5. Verify real inputs separately from compiler compatibility

Use the two ZIPs and extracted folders read-only as local acceptance inputs; do not commit manuscript content or absolute machine paths into automated fixtures. Use small synthetic counterparts for CI, and a local fixture runner/acceptance record for these samples. Verify paths, text decoding, asset hashes, selected root, zero-peer acquisition, reopen, and later source synchronization. Run the supported local compiler in isolated temporary directories and record any genuine TeX/package failure separately from input readiness. A source failure cannot count as a successful PDF build; no fake engine establishes real compilation success.

## Risks / Trade-offs

- [Promoting an incomplete joined copy] → Require initialization evidence; test joins and partial remote bodies explicitly.
- [Crash between content and availability writes] → Commit content first, then durable initialization evidence; surface storage failure, retain retryable data.
- [Stale native renderer completeness] → Refresh from the actor at acquisition/reattach and notify availability changes.
- [Sample depends on packages or source behavior the local engine does not support] → Run real compiler checks; record exact causes without enabling shell escape or editing the originals. Nature loads `svg`; JBHI contains multiple roots and case-sensitive bibliography naming worth checking.
- [Private fixture portability] → Keep originals external and use synthetic regression fixtures in CI.

## Migration Plan

1. Add backward-compatible initialization evidence and local recovery without changing project identities or source content.
2. Wire all creation paths and import durability, then the home action and diagnostics.
3. Validate current creation, restart, partial joins and evidence-backed legacy recovery using both renderer modes.
4. Existing stores without reliable evidence retain their content and receive local restoration guidance. Rolling back ignores the additive metadata; do not rewrite or delete source/history stores.
