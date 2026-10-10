# Proposal

## Why

Joining project `df72heljrgs56wmo` gave no sign of whether anything was syncing: the user waited about 10 minutes
before the data appeared, saw "No co-authors online" although the other person was connected, and had no way to tell
"connecting", "file list received", "files still downloading" and "done" apart. Today the status bar says
"All changes synced" as soon as any peer is linked (even if no file content arrived yet), and a co-author is shown only
once a direct peer link is fully authenticated and synced, so every slow step looks like nothing happening.

## What Changes

- Show the real connection stage while joining: looking for co-authors, co-author found on the relay but not yet
  connected, connected and receiving the file list, receiving contents, up to date. Co-authors who are online but not
  yet connected appear in the people list, marked "connecting".
- Show the file list as soon as it arrives, with a per-file state (up to date, waiting to download, downloading,
  being edited by someone) and mark in the file tree the files not yet received.
- Show a sync progress percentage (files received of files known) with a count and, when known, bytes, in the status
  bar and in a new Sync panel; plus "last synced" time.
- Add a "Sync now" button (status bar and Sync panel) that re-contacts co-authors, retries stalled links, re-requests
  every file and downloads everything; it reports its result.
- Show a short notification when a join/sync finishes or stalls, and which files co-authors are editing right now
  (their color on the file, as presence already does for the tree).
- Stop abandoning a co-author for good after 8 failed link attempts: keep retrying (capped backoff) while they are
  online, a probable cause of the 10-minute join.
- Replace the "All changes synced" claim with one that is true only when nothing is pending.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `peer-sync`: new requirements for observable sync progress, file-level sync state, manual sync, link retry
  persistence; modified presence (co-authors still connecting) and initial sync for new members.
- `workspace-layout`: modified status bar (truthful sync state, progress, last sync, Sync now, co-authors connecting).

## Impact

- `packages/sync`: `mesh.ts` (per-document/peer sync tracking, `resync`), `connect.ts` (link/relay state exposure,
  unlimited capped retry, `reconnectNow`), `blobs.ts` (pending/have counts, bulk fetch), `model.ts` (read-only
  helpers).
- `apps/web`: `session.svelte.ts` (reactive `syncStatus`), `StatusBar.svelte`, `PeoplePanel.svelte`,
  `FileTree.svelte`, new `SyncPanel.svelte`, notification toast, `Workspace.svelte` wiring.
- No wire-protocol break and no control-plane change: new data is derived locally from existing frames (STEP1/STEP2,
  blob announcements, signaling `ready/join` lists). Document content still never reaches the control plane.
- Tests: `packages/sync` unit tests, `apps/web` unit tests, e2e for a slow join (existing `e2e/zz-repro.spec.ts` is an
  unrelated working copy and stays untouched).
