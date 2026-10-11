import type { SyncEvent, SyncSnapshot } from '@hivetex/sync';

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
    case 'synced':
      return `All changes synced · ${sinceText(s.lastSyncAt, now)}`;
  }
}

/** Text for the notification of a sync event. */
export function syncEventText(e: SyncEvent, s: SyncSnapshot | null): string {
  if (e === 'complete') return `All ${s?.total ?? 0} files received. This device is up to date.`;
  const missing = s ? s.total - s.received : 0;
  return s && s.stage === 'connecting'
    ? 'Still connecting to your co-author. Use "Sync now" to retry the connection.'
    : `Sync is slow or stuck${missing ? `: ${missing} files missing` : ''}. Use "Sync now" to retry.`;
}

/** What "Sync now" tells the user, from the state right after it ran. */
export function syncNowMessage(s: SyncSnapshot | null, r: { missingText: number; missingBinaries: number; failed: number } | null): string {
  if (!s || (s.peers === 0 && s.connecting === 0)) return 'No co-author is online. Your edits are kept on this device.';
  if (s.peers === 0) return `Reconnecting to ${s.connecting} co-author${s.connecting === 1 ? '' : 's'}…`;
  const missing = r ? r.missingText + r.missingBinaries : s.total - s.received;
  if (missing === 0) return 'Everything is up to date.';
  const failed = r?.failed ? ` ${r.failed} could not be fetched yet: no connected co-author has them.` : '';
  return `Asked ${s.peers} co-author${s.peers === 1 ? '' : 's'} for ${missing} missing file${missing === 1 ? '' : 's'}.${failed}`;
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
