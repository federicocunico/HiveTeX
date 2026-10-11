import { describe, expect, it } from 'vitest';
import { createLocalProject, forgetLocalProject, getLocalProject, isLocalProjectId, listLocalProjects } from '../src/lib/local-projects.js';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('local projects registry', () => {
  it('creates, lists and forgets projects that exist only on this computer', () => {
    const s = memory();
    let n = 0;
    const a = createLocalProject('  My   thesis ', s, () => `u${++n}`);
    const b = createLocalProject('', s, () => `u${++n}`);
    expect(a).toMatchObject({ id: 'local-u1', name: 'My thesis' });
    expect(b.name).toBe('Untitled');
    expect(listLocalProjects(s).map((p) => p.id)).toEqual(['local-u1', 'local-u2']);
    // the workspace opens it from the same cache it uses offline
    expect(JSON.parse(s.getItem('hivetex.proj.local-u1') as string)).toMatchObject({ id: 'local-u1', slug: 'My thesis', role: 'owner' });
    expect(getLocalProject('local-u2', s)?.name).toBe('Untitled');
    forgetLocalProject('local-u1', s);
    expect(listLocalProjects(s).map((p) => p.id)).toEqual(['local-u2']);
    expect(s.getItem('hivetex.proj.local-u1')).toBeNull();
    expect(isLocalProjectId('local-u2')).toBe(true);
    expect(isLocalProjectId('abc')).toBe(false);
  });

  it('ignores a corrupt registry', () => {
    const s = memory();
    s.setItem('hivetex.localProjects', '{nope');
    expect(listLocalProjects(s)).toEqual([]);
  });
});
