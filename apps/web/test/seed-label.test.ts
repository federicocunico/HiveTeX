import { describe, expect, it } from 'vitest';
import { seedLabel } from '../src/lib/seeds.js';

describe('background project status (11.3)', () => {
  it('distinguishes every documented state', () => {
    const t = (stage: string, status?: Parameters<typeof seedLabel>[1]) => seedLabel(stage, status).text;
    expect(t('dormant')).toBe('Reachable on request');
    expect(t('waking')).toBe('Waking');
    expect(t('ring-channel-unreachable')).toBe('Wake-up service unreachable');
    expect(t('queued')).toMatch(/^Queued/);
    expect(t('receiving', { syncStatus: { stage: 'receiving', files: [{ have: true }, { have: false }] } })).toMatch(/^Incomplete/);
    expect(t('synced', { peers: [{ limited: 'relay_budget_exhausted' }] })).toMatch(/relay limit/);
    expect(t('auth-required')).toBe('Sign in to resume');
    expect(t('offline')).toBe('Offline');
    expect(t('save-failure')).toMatch(/^Save failed/);
    expect(t('synced', { saveFailing: true })).toMatch(/^Save failed/);
    expect(t('synced', { conflicts: [{}] })).toMatch(/^Unresolved conflict/);
    expect(t('receiving', { syncStatus: { files: [{ have: false, deferred: 'storage-full' }] } })).toMatch(/disk space/);
    expect(t('paused')).toBe('Work offline');
    expect(t('synced')).toBe('Up to date with co-authors');
    // Seed availability never reads as someone editing.
    for (const s of ['dormant', 'waking', 'synced', 'alone']) expect(t(s)).not.toMatch(/editing|online now/i);
  });
  it('flags only states that need the member', () => {
    expect(seedLabel('dormant').attention).toBe(false);
    expect(seedLabel('auth-required').attention).toBe(true);
    expect(seedLabel('synced', { conflicts: [{}] }).attention).toBe(true);
  });
});
