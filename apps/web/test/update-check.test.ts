// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UpdateBadge from '../src/components/UpdateBadge.svelte';
import { checkForUpdate, compareVersions, dismissUpdate, isDismissed, parseRelease, repoSlug } from '../src/lib/update-check.js';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.0',
  html_url: 'https://github.com/federicocunico/HiveTeX/releases/tag/v0.3.0',
  draft: false,
  prerelease: false,
  ...over,
});
const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
const flush = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
};

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });
  it('accepts a v prefix and ignores pre-release suffixes', () => {
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(0);
  });
  it('treats non-versions as equal', () => {
    expect(compareVersions('nightly', '0.3.0')).toBe(0);
  });
});

describe('parseRelease / repoSlug', () => {
  it('reads a published release', () => {
    expect(parseRelease(release())).toEqual({ version: '0.3.0', url: 'https://github.com/federicocunico/HiveTeX/releases/tag/v0.3.0' });
  });
  it('ignores drafts, pre-releases and malformed answers', () => {
    expect(parseRelease(release({ draft: true }))).toBeNull();
    expect(parseRelease(release({ prerelease: true }))).toBeNull();
    expect(parseRelease(release({ tag_name: 'nightly' }))).toBeNull();
    expect(parseRelease(release({ html_url: 'https://evil.example/x' }))).toBeNull();
    expect(parseRelease(release({ html_url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease('x')).toBeNull();
  });
  it('derives owner/repo from the source URL', () => {
    expect(repoSlug('https://github.com/federicocunico/HiveTeX')).toBe('federicocunico/HiveTeX');
    expect(repoSlug('https://github.com/a/b.git')).toBe('a/b');
    expect(repoSlug('https://example.com/a/b')).toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('returns the release when it is newer', async () => {
    expect((await checkForUpdate('0.2.1', answer(release()), 'o/r'))?.version).toBe('0.3.0');
  });
  it('returns null when up to date or ahead', async () => {
    expect(await checkForUpdate('0.3.0', answer(release()), 'o/r')).toBeNull();
    expect(await checkForUpdate('0.4.0', answer(release()), 'o/r')).toBeNull();
  });
  it('is silent when offline, rate limited or without releases', async () => {
    expect(await checkForUpdate('0.2.1', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch, 'o/r')).toBeNull();
    expect(await checkForUpdate('0.2.1', answer({}, false), 'o/r')).toBeNull();
    expect(await checkForUpdate('0.2.1', answer(release()), null)).toBeNull();
  });
});

describe('dismissal', () => {
  beforeEach(() => localStorage.clear());
  it('stays dismissed for that version only', () => {
    expect(isDismissed('0.3.0')).toBe(false);
    dismissUpdate('0.3.0');
    expect(isDismissed('0.3.0')).toBe(true);
    expect(isDismissed('0.4.0')).toBe(false);
  });
});

describe('UpdateBadge', () => {
  beforeEach(() => localStorage.clear());
  const info = { version: '0.3.0', url: 'https://github.com/federicocunico/HiveTeX/releases/tag/v0.3.0' };

  it('announces the version and Download opens the release page', async () => {
    const open = vi.fn();
    render(UpdateBadge, { current: '0.2.1', check: async () => info, open });
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Version 0.3.0 is available');
    await fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(open).toHaveBeenCalledWith(info.url);
  });
  it('shows nothing when there is no newer release', async () => {
    render(UpdateBadge, { current: '0.3.0', check: async () => null, open: vi.fn() });
    await flush();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('dismissing hides it, also after a restart, until a newer release appears', async () => {
    const first = render(UpdateBadge, { current: '0.2.1', check: async () => info, open: vi.fn() });
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();

    render(UpdateBadge, { current: '0.2.1', check: async () => info, open: vi.fn() });
    await flush();
    expect(screen.queryByRole('status')).toBeNull();

    render(UpdateBadge, { current: '0.2.1', check: async () => ({ ...info, version: '0.4.0' }), open: vi.fn() });
    await flush();
    expect(screen.getByRole('status').textContent).toContain('0.4.0');
  });
});
