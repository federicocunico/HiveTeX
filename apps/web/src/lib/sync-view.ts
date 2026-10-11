import type { SyncEvent, SyncOutcome, SyncSnapshot } from '@hivetex/sync';

/** "just now", "3 min ago", "2 h ago": when the device was last fully up to date. */
export function sinceText(at: number | null, now = Date.now()): string {
  if (at === null) return 'not yet';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** One plain-language line for the status bar. "All changes synced" is only ever said when nothing is missing. */
export function syncLabel(s: SyncSnapshot | null, now = Date.now(), saveFailing = false): string {
  if (saveFailing && (!s || s.stage === 'alone' || s.stage === 'offline')) return 'Edits are not saved on this device yet';
  if (!s) return 'Saved on this device';
  switch (s.stage) {
    case 'offline':
      return 'Offline: edits are kept and sync when you reconnect';
    case 'alone':
      return 'Saved on this device. No co-author online';
    case 'connecting':
      return s.connecting === 1 ? 'Connecting to a co-author…' : `Connecting to ${s.connecting} co-authors…`;
    case 'receiving':
      if (s.percent === null) return 'Syncing: receiving the file list…';
      return `Syncing ${s.percent}%: ${s.received} of ${s.total} files`;
    case 'reconciling':
      // The content is here and usable (and saved, see saveFailing); the current co-authors have not answered for all of it.
      return `Checking with co-authors: ${s.reconciled} of ${s.total} files`;
    case 'synced':
      return `All changes synced · ${sinceText(s.lastSyncAt, now)}`;
  }
}

/** Text for the notification of a sync event. */
export function syncEventText(e: SyncEvent, s: SyncSnapshot | null): string {
  if (e === 'complete') return `All ${s?.total ?? 0} files received. This device is up to date.`;
  const missing = s ? s.total - s.received : 0;
  if (s?.stage === 'connecting') return 'Still connecting to your co-author. Use "Sync now" to retry the connection.';
  if (s?.stage === 'reconciling') return 'Still checking with your co-authors; your files are usable meanwhile. Use "Sync now" to retry.';
  return `Sync is slow or stuck${missing ? `: ${missing} files missing` : ''}. Use "Sync now" to retry.`;
}

/**
 * What "Sync now" tells the user, from how the round ended. Only a completed round says everything is up to date:
 * requests that nobody answered are reported as pending, and the edits on this device are kept either way.
 */
export function syncNowMessage(s: SyncSnapshot | null, r: SyncOutcome | null): string {
  if (!s || (s.peers === 0 && s.connecting === 0)) return 'No co-author is online. Your edits are kept on this device.';
  if (s.peers === 0) return `Reconnecting to ${s.connecting} co-author${s.connecting === 1 ? '' : 's'}…`;
  const who = `${s.peers} co-author${s.peers === 1 ? '' : 's'}`;
  if (!r) return `Asking ${who}…`;
  if (r.status === 'complete') return 'Everything is up to date.';
  if (r.status === 'pending') {
    const left = r.pending || r.missingText + r.missingBinaries;
    return `No answer yet from ${who} for ${left} file${left === 1 ? '' : 's'}. Your edits are kept; try again in a moment.`;
  }
  const missing = r.missingText + r.missingBinaries || r.failed;
  return `${missing} missing file${missing === 1 ? '' : 's'}: no connected co-author can supply ${missing === 1 ? 'it' : 'them'} right now. Your edits are kept.`;
}

/** Who is editing which file: path → names, from presence. */
export function editorsByFile(people: Array<{ name: string; file: string | null }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of people) if (p.file) out.set(p.file, [...(out.get(p.file) ?? []), p.name]);
  return out;
}

/** The persistent warning while edits cannot be written to this device's storage (null when saving works). */
export function saveWarning(saveFailing: boolean): string | null {
  return saveFailing ? 'Not saved on this device: storage is failing. Export a recovery copy now.' : null;
}

/** What to tell the member while their offline changes wait to be merged (null when nothing is wrong). */
export function mergeNotice(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error && error.name === 'MergePending') return 'Your offline changes are kept and waiting for a co-author to confirm the project. They are merged as soon as one does.';
  return 'Your offline changes are kept, but could not be prepared for merging yet. This is retried when a co-author connects.';
}
