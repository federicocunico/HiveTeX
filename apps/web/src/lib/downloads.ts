/** Desktop downloads for the landing page: the visitor's OS first, links resolved to the latest release on click. */
export type Os = 'windows' | 'macos' | 'linux';

export const OS_LABEL: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

export function detectOs(ua: string, platform = ''): Os | null {
  const s = `${platform} ${ua}`;
  if (/Win/i.test(s)) return 'windows';
  if (/iPhone|iPad|iPod|Android/i.test(s)) return null;
  if (/Mac/i.test(s)) return 'macos';
  if (/Linux|X11|CrOS/i.test(s)) return 'linux';
  return null;
}

/** All three, the detected one first. */
export function osOrder(detected: Os | null): Os[] {
  const all: Os[] = ['windows', 'macos', 'linux'];
  return detected ? [detected, ...all.filter((o) => o !== detected)] : all;
}

/** `https://github.com/owner/repo(.git)` → { owner, repo }. */
export function repoOf(sourceUrl: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(sourceUrl.trim());
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

export function releasesPage(sourceUrl: string): string {
  const r = repoOf(sourceUrl);
  return r ? `https://github.com/${r.owner}/${r.repo}/releases/latest` : sourceUrl;
}

type Asset = { name: string; browser_download_url: string };

/** The installer for `os` among a release's assets (Windows setup .exe, macOS .dmg, Linux AppImage). */
export function pickAsset(assets: Asset[], os: Os): string | null {
  const test: Record<Os, RegExp> = {
    windows: /_x64-setup\.exe$/i,
    macos: /\.dmg$/i,
    linux: /\.AppImage$/i,
  };
  const fallback: Record<Os, RegExp> = { windows: /\.(exe|msi)$/i, macos: /\.dmg$/i, linux: /\.(AppImage|deb)$/i };
  const hit = assets.find((a) => test[os].test(a.name)) ?? assets.find((a) => fallback[os].test(a.name));
  return hit?.browser_download_url ?? null;
}

/** Latest installer URL for `os`, or the releases page when it cannot be determined. */
export async function latestDownload(os: Os, sourceUrl: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const r = repoOf(sourceUrl);
  const page = releasesPage(sourceUrl);
  if (!r) return page;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${r.owner}/${r.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return page;
    const body = (await res.json()) as { assets?: Asset[] };
    return pickAsset(body.assets ?? [], os) ?? page;
  } catch {
    return page;
  }
}
