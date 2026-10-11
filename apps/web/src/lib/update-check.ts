import { safeStorage } from './api.js';
import { SOURCE_URL } from './links.js';

/** A published release newer than the running app. */
export interface UpdateInfo {
  version: string;
  url: string;
}

const DISMISSED_KEY = 'updateDismissed';

/** `v0.10.1` / `0.10.1` / `0.10.1-beta.1` → [0, 10, 1]; null when it is not a version. Pre-release suffixes are ignored. */
function parts(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric comparison (0.10.0 > 0.9.0). Returns 0 when either side is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number) ? 1 : -1;
  return 0;
}

/** Reads the answer of GitHub's "latest release" endpoint; null for drafts, pre-releases and anything malformed. */
export function parseRelease(json: unknown): UpdateInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  const p = parts(r.tag_name);
  if (!p) return null;
  let url: URL;
  try {
    url = new URL(r.html_url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  return { version: p.join('.'), url: url.href };
}

/** `https://github.com/owner/repo` → `owner/repo` (forks set VITE_SOURCE_URL). */
export function repoSlug(sourceUrl: string = SOURCE_URL): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(sourceUrl.trim());
  return m?.[1] ?? null;
}

/**
 * Asks GitHub for the repository's latest published release. Resolves to the release when it is newer than `current`,
 * otherwise (up to date, offline, rate limited, no releases, unexpected answer) to null: the check never throws.
 */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch, slug: string | null = repoSlug()): Promise<UpdateInfo | null> {
  if (!slug) return null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const release = parseRelease(await res.json());
    return release && compareVersions(release.version, current) > 0 ? release : null;
  } catch {
    return null;
  }
}

export const isDismissed = (version: string): boolean => safeStorage(DISMISSED_KEY) === version;

/** Remembers on this device that the badge for `version` was dismissed; a higher version shows it again. */
export function dismissUpdate(version: string): void {
  safeStorage(DISMISSED_KEY, version);
}
