/** Windows reserved device names, also with an extension: CONIN$/CONOUT$, COM0-9/LPT0-9 and the superscript digits. */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

/** The name a case-insensitive, normalization-insensitive host (NTFS, APFS, HFS+, exFAT) gives a path. */
export const hostKey = (path: string) => path.split('/').map((p) => p.normalize('NFC').toLowerCase().replace(/[ .]+$/, '')).join('/');

/** Conservative portable host mapping. Refuse ambiguous paths instead of guessing which bytes to overwrite. */
export function pathCollisions(entries: Array<{ path: string; kind?: string; id?: string }>): Set<string> {
  const blocked = new Set<string>();
  const byKey = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (entry.path.split('/').some((p) => RESERVED.test(p) || /[<>:"|?*]/.test(p) || /[ .]$/.test(p))) blocked.add(entry.path);
    const k = hostKey(entry.path), group = byKey.get(k) ?? [];
    group.push(entry); byKey.set(k, group);
  }
  for (const [k, group] of byKey) {
    if (new Set(group.map((e) => e.path)).size > 1 || new Set(group.flatMap((e) => e.id ? [e.id] : [])).size > 1) for (const entry of group) blocked.add(entry.path);
    const segments = k.split('/');
    for (let n = 1; n < segments.length; n++) {
      const parents = byKey.get(segments.slice(0, n).join('/')) ?? [];
      if (parents.some((p) => p.kind !== 'dir')) for (const entry of [...group, ...parents]) blocked.add(entry.path);
    }
  }
  return blocked;
}
