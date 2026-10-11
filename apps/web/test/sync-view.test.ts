import type { SyncOutcome, SyncSnapshot } from '@hivetex/sync';
import { describe, expect, it } from 'vitest';
import { editorsByFile, sinceText, syncEventText, syncLabel, syncNowMessage } from '../src/lib/sync-view.js';

const snap = (o: Partial<SyncSnapshot> = {}): SyncSnapshot => ({
  stage: 'synced', peers: 1, connecting: 0, rootSynced: true, rootReconciled: true, total: 10, received: 10, reconciled: 10, percent: 100, files: [], lastSyncAt: 1000, stalled: false, ...o,
});

describe('sync labels', () => {
  it('never says all synced while files are missing', () => {
    expect(syncLabel(snap({ stage: 'receiving', received: 4, percent: 40 }))).toBe('Syncing 40%: 4 of 10 files');
    expect(syncLabel(snap({ stage: 'receiving', received: 4, percent: 40 }))).not.toContain('All changes synced');
    expect(syncLabel(snap({ stage: 'receiving', percent: null }))).toContain('file list');
  });
  it('states the other stages in words', () => {
    expect(syncLabel(null)).toBe('Saved on this device');
    expect(syncLabel(snap({ stage: 'alone', peers: 0 }))).toContain('No co-author online');
    expect(syncLabel(snap({ stage: 'connecting', peers: 0, connecting: 2 }))).toBe('Connecting to 2 co-authors…');
    expect(syncLabel(snap({ stage: 'offline' }))).toContain('Offline');
    // cached content is usable, but "synced" is only said once the current co-authors answered for it
    expect(syncLabel(snap({ stage: 'reconciling', reconciled: 3, percent: 30 }))).toBe('Checking with co-authors: 3 of 10 files');
    expect(syncLabel(snap({ stage: 'reconciling', reconciled: 3 }))).not.toContain('All changes synced');
    expect(syncLabel(snap({ lastSyncAt: 1000 }), 1000 + 180_000)).toBe('All changes synced · 3 min ago');
  });
  it('formats elapsed time', () => {
    expect(sinceText(null)).toBe('not yet');
    expect(sinceText(0, 5000)).toBe('just now');
    expect(sinceText(0, 30_000)).toBe('30 s ago');
    expect(sinceText(0, 7_200_000)).toBe('2 h ago');
  });
  it('words the notifications and the Sync now result', () => {
    expect(syncEventText('complete', snap())).toContain('All 10 files received');
    expect(syncEventText('stalled', snap({ stage: 'receiving', received: 4 }))).toContain('6 files missing');
    expect(syncEventText('stalled', snap({ stage: 'connecting', peers: 0, connecting: 1 }))).toContain('connecting');
    const out = (o: Partial<SyncOutcome> = {}): SyncOutcome => ({ status: 'complete', requested: 10, reconciled: 10, missingText: 0, missingBinaries: 0, pending: 0, failed: 0, ...o });
    expect(syncNowMessage(snap({ stage: 'alone', peers: 0 }), null)).toContain('No co-author is online');
    expect(syncNowMessage(snap({ stage: 'connecting', peers: 0, connecting: 1 }), null)).toBe('Reconnecting to 1 co-author…');
    expect(syncNowMessage(snap(), out())).toBe('Everything is up to date.');
    // requests that nobody answered are not success, and the edits stay
    const pending = syncNowMessage(snap({ stage: 'reconciling' }), out({ status: 'pending', reconciled: 4, pending: 6 }));
    expect(pending).toContain('No answer yet');
    expect(pending).toContain('6 files');
    expect(pending).not.toContain('up to date');
    const failed = syncNowMessage(snap({ stage: 'receiving', received: 4 }), out({ status: 'failed', missingText: 4, missingBinaries: 2, failed: 1 }));
    expect(failed).toContain('6 missing files');
    expect(failed).toContain('kept');
    expect(syncEventText('stalled', snap({ stage: 'reconciling' }))).toContain('checking');
  });
  it('groups editors by file', () => {
    expect(editorsByFile([{ name: 'ada', file: 'a.tex' }, { name: 'kenji', file: 'a.tex' }, { name: 'x', file: null }]).get('a.tex')).toEqual(['ada', 'kenji']);
  });
});

describe('merge notice', () => {
  it('explains a waiting merge, a failed preparation, and says nothing without an error', async () => {
    const { mergeNotice } = await import('../src/lib/sync-view.js');
    const { MergePending } = await import('@hivetex/sync');
    expect(mergeNotice(null)).toBeNull();
    expect(mergeNotice(new MergePending('root', 'timeout'))).toContain('waiting');
    expect(mergeNotice(new MergePending('root', 'timeout'))).toContain('kept');
    expect(mergeNotice(new Error('load failed'))).toContain('could not be prepared');
  });
});
