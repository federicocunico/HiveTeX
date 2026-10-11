# Proposal

## Why

HiveTeX already has a capable peer-to-peer editing stack, but the repository audit found reproducible gaps in local durability, merge recovery, connection lifecycle, and consumers of incompletely synchronized content. Passing happy-path tests currently does not protect users from lost offline work, overwritten folder edits, incomplete backups, or misleading synchronization status.

## What Changes

- Make persistence failures recoverable and visible; journal offline work durably before replacing documents, and require actual document receipt before completing a merge.
- Introduce explicit document readiness and reconciliation generations, used by sync progress, duplicate cleanup, folder mirroring, export, compilation, and backup.
- Recover automatically after offline startup; make signaling presence, TURN refresh, connection attempts, and shutdown behave correctly across long sessions and interrupted setup.
- Accept membership epochs only with verified authority, bound fragment/blob resource consumption, and cancel pending sends when a channel closes.
- Preserve concurrent folder edits, bind the editor only to its current file, and build compile/backup results from immutable, complete inputs.
- Add fault-injection, delayed-transfer, lifecycle, and real-browser regression coverage while retaining the existing real-time latency target.
- Record prioritized audit findings, evidence, limitations, compatibility choices, and implementation order in `design.md`.

## Capabilities

### New Capabilities

None. These changes strengthen existing behavior boundaries.

### Modified Capabilities

- `peer-sync`: recoverable persistence, crash-safe merge checkpoints, receipt-based readiness, safe duplicate cleanup, bounded transport, and reliable long-lived connectivity.
- `project-access`: authoritative epoch advancement and monotonic permission enforcement across asynchronous work and reconnection.
- `latex-workspace`: safe editor binding, complete exports, and preservation of folder edits during reconciliation.
- `distributed-compilation`: complete immutable compile inputs and result identity that includes engine and main-file settings.
- `github-backup`: incomplete source acquisition must not delete remote assets; edits made during a backup remain pending.

## Impact

Primary changes affect `packages/sync/src/{persistence,model,fork,mesh,connect,transport,frames,blobs,sync-status,mirror}.ts`, the native RTC adapter, `server/src/signal/{hub,turn}.ts`, `apps/web/src/lib/session.svelte.ts`, and `apps/web/src/components/Editor.svelte`. Snapshot consumers in `packages/compile`, `packages/github`, and workspace export must adopt the same readiness contract. Tests span package tests, signaling integration tests, browser end-to-end tests, and native transport parity.

Preserve the Yjs document format, encrypted peer content path, viewer write restrictions, and existing control-plane privacy guarantees. Recovery metadata needs a versioned, additive migration. New receipt/capability messages need negotiated support and conservative behavior with older clients; no unconditional wire-format replacement is proposed.

This is a planning-only change. It does not implement fixes, upgrade dependencies, deploy services, or claim production network validation. Account flows and native compiler isolation were not comprehensively audited. Multi-tab ownership, viewer-only bootstrap, and broader native/security review are explicitly tracked as follow-up boundaries in the design.
