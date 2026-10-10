import { describe, expect, it } from 'vitest';
import { detectOs, latestDownload, osOrder, pickAsset, releasesPage, repoOf } from '../src/lib/downloads.js';

const SRC = 'https://github.com/federicocunico/HiveTeX';
const assets = [
  { name: 'HiveTeX_0.2.0_x64-setup.exe', browser_download_url: 'https://dl/win.exe' },
  { name: 'HiveTeX_0.2.0_x64_en-US.msi', browser_download_url: 'https://dl/win.msi' },
  { name: 'HiveTeX_0.2.0_universal.dmg', browser_download_url: 'https://dl/mac.dmg' },
  { name: 'HiveTeX_0.2.0_amd64.AppImage', browser_download_url: 'https://dl/linux.AppImage' },
  { name: 'HiveTeX_0.2.0_amd64.deb', browser_download_url: 'https://dl/linux.deb' },
  { name: 'latest.json', browser_download_url: 'https://dl/latest.json' },
];

describe('downloads', () => {
  it('detects the visitor OS', () => {
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('macos');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBeNull();
    expect(detectOs('Mozilla/5.0 (Linux; Android 14)')).toBeNull();
    expect(detectOs('Something else')).toBeNull();
  });

  it('lists the detected OS first', () => {
    expect(osOrder('linux')).toEqual(['linux', 'windows', 'macos']);
    expect(osOrder(null)).toEqual(['windows', 'macos', 'linux']);
  });

  it('picks the installer for each OS', () => {
    expect(pickAsset(assets, 'windows')).toBe('https://dl/win.exe');
    expect(pickAsset(assets, 'macos')).toBe('https://dl/mac.dmg');
    expect(pickAsset(assets, 'linux')).toBe('https://dl/linux.AppImage');
    expect(pickAsset([assets[1] as (typeof assets)[0]], 'windows')).toBe('https://dl/win.msi');
    expect(pickAsset([], 'linux')).toBeNull();
  });

  it('parses the repository and builds the releases page', () => {
    expect(repoOf(`${SRC}.git`)).toEqual({ owner: 'federicocunico', repo: 'HiveTeX' });
    expect(repoOf('https://example.org/x')).toBeNull();
    expect(releasesPage(SRC)).toBe(`${SRC}/releases/latest`);
  });

  it('resolves the latest installer, falling back to the releases page', async () => {
    const ok = (async () => new Response(JSON.stringify({ assets }), { status: 200 })) as typeof fetch;
    const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    const offline = (async () => {
      throw new TypeError('network');
    }) as typeof fetch;
    expect(await latestDownload('macos', SRC, ok)).toBe('https://dl/mac.dmg');
    expect(await latestDownload('windows', SRC, notFound)).toBe(`${SRC}/releases/latest`);
    expect(await latestDownload('linux', SRC, offline)).toBe(`${SRC}/releases/latest`);
    expect(await latestDownload('linux', 'https://example.org/src', ok)).toBe('https://example.org/src');
  });
});
