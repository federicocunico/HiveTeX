# Design

## Context

Observed in code (see proposal.md for motivation):

- `StatusBar.svelte` shows "All changes synced" whenever `session.noPeerOnline` is false, i.e. as soon as one peer is
  linked. The people count uses `session.peers` = `Mesh.peers`, only fully authenticated links. A co-author visible on
  the signaling relay but not yet linked (`ConnectionManager.onRelay` / `known`) is invisible to the UI.
- `Mesh.startSync` requests state for the docs it already knows (root first). Text docs of files discovered later are
  fetched only when opened (`openDoc`) or by `prefetchAll`; binaries are fetched on demand by `BlobManager`. Nothing
  records "received from a peer", so no progress can be derived today.
- `ConnectionManager.retryLater` gives up after 8 attempts (about 2.5 minutes with 20 s link timeouts and 30 s
  backoff cap). If the peer is not announced again, nothing retries afterwards. This is the leading hypothesis for the
  ~10 minute join; it must be confirmed by the instrumentation below rather than assumed.
- Presence (`awareness`) only flows over linked peers, so "no co-authors online" and "no presence" are the same
  symptom of an unlinked peer.

## Goals / Non-Goals

**Goals:**
- A truthful, local-only sync model the UI reads: stage, per-file state, progress, last sync time.
- Visibility of co-authors that are online but not connected, and why (relay-visible, link attempt n, last error).
- A "Sync now" action that unsticks a stalled join.
- No wire-protocol change; content still never touches the control plane.

**Non-Goals:**
- Faster transfer (compression, parallel chunking, TURN tuning). Measure first; separate change if needed.
- Showing a co-author's keystrokes or file contents in the notification.
- Unbounded prefetch: binaries are fetched in the background with concurrency 2 and a 20 s timeout per file; a file nobody can serve is retried by "Sync now".

## Decisions

1. **`SyncTracker` in `packages/sync` fed by Mesh/Blobs events.** Tracks per doc: `requested`, `receivedFrom: Set<peer>`
   (set on first STEP2 applied), and for blobs: have/pending (from `BlobManager`). It exposes
   `snapshot(): SyncSnapshot` and `onChange(cb)` (throttled to ~4/s). Alternative: poll the stores from the UI. Rejected:
   cannot tell "received from a peer" from "created locally" and wastes CPU on big projects.
2. **Progress = received files / known files**, file list from `ProjectModel.list()`. Text file is received when its
   doc got a STEP2 (or has local content and we are the author: files created locally count as received). Binary file
   is received when its hash is present in the blob store. Directories are excluded. Percentage is shown only when a
   peer is connected and the root doc has synced; otherwise stage text explains why (no honest number exists).
   Alternative: bytes-based progress. Rejected: sizes of text docs are unknown before transfer; bytes shown only as a
   secondary figure.
3. **Stages** (single enum, derived): `offline` (paused/no network), `alone` (no co-author online), `connecting`
   (relay-visible peers, no link yet), `receiving` (linked, files missing), `synced`. "Stalled" is a flag: stage is
   `connecting`/`receiving` with no progress event for 60 s; it drives the notification.
4. **Connecting co-authors**: `ConnectionManager` exposes `candidates()` = devices in `known` that are `onRelay` or
   announced via pex but not connected, with `{dev, uname, attempts, lastError, linking}` (uname from ticket claims, so
   no new data). `ProjectSession.peers` stays "connected"; a new `connecting` list feeds the status bar and People
   panel. Alternative: add them to `peers` with a flag. Rejected: many consumers (compile election, backup) assume
   `peers` are live links.
5. **Unlimited capped retry.** Replace the 8-attempt cap with: keep retrying while the device is relay-visible or
   pex-announced, backoff 1,2,4…30 s. Attempts reset on connect. Because retry is unbounded, it is also stopped when
   the device leaves the relay (existing `leave` handling) or on `stop()`.
6. **Sync now** = `session.syncNow()`: (a) `manager.reconnectNow()` – reset `attempts`, close stalled links, reopen the
   socket if wanted, `maybeConnect` every known candidate; (b) `mesh.resync()` – re-send STEP1 for every requested doc
   to every peer and `openDoc` for all text files (existing `prefetchAll`); (c) `blobs` fetch of all missing binaries
   with bounded concurrency; (d) resolves with a summary `{peers, missingText, missingBinaries}` for the toast; sets
   `lastSyncAt` when the tracker reports complete. Alternative: only re-send STEP1. Rejected: does nothing when the
   problem is the link.
7. **Per-file editing marker**: reuse awareness `file` already published by `setOpenFile`; a file is "being edited by X"
   when X has it open (cursor activity timestamp is optional and deferred). The file tree already draws a dot per
   person (`presence` prop); the Sync panel lists the same data, and unreceived files get a muted "waiting" icon.
8. **UI**: status bar sync item shows `Syncing 40%` / `Up to date · 2 min ago` / `Looking for co-authors…` and
   opens a new Sync panel (rail entry beside People). Panel content: stage line, progress bar, file list with state
   and editors, last sync time, "Sync now". Notifications use the existing toast mechanism; if none exists the
   StatusBar `pill` with `role="status"` pattern (as `mirrorNotice`) is used.
9. **Diagnostics for the reported case**: the tracker also records stage timestamps (relay seen, link up, root synced,
   first file, complete) and exposes them in the Sync panel's "Details" and on `window.__p2p` in test mode, so the
   next slow join can be explained from data instead of guessed.

## Risks / Trade-offs

- [Large projects (thousands of files) make per-file tracking expensive] → tracker stores sets keyed by file id, emits
  throttled snapshots, Sync panel list is virtualized or capped with "show all".
- [Counting "received" wrongly reports 100% while a late peer has newer edits] → progress is "files received", the
  stage returns to `receiving` when a peer's STEP1/updates reveal missing state; copy never claims more than "up to
  date with connected co-authors".
- [Unlimited retry hammers the relay] → backoff caps at 30 s per device and only for relay-visible devices.
- [Sync now floods the network on big projects] → bounded concurrency for blob fetch, and the button is disabled
  while a sync-now run is active.
- [Hypothesis about the 8-attempt cap may be wrong] → diagnostics (decision 9) are delivered in the same change; a
  follow-up is opened if data shows another bottleneck.
