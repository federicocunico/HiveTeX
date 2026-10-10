import { describe, expect, it } from 'vitest';
import { type FolderDeps, runFolderAction } from '../src/lib/project-folder.js';

function deps(bound: string | null) {
  const calls: string[] = [];
  let path = bound;
  const d: FolderDeps = {
    projectId: 'p1',
    slug: 'thesis-2026',
    boundPath: () => path,
    bind: async (p) => {
      calls.push(`bind ${p}`);
      path = p;
    },
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push(`${cmd} ${JSON.stringify(args)}`);
      return (cmd === 'mirror_default_folder' ? 'C:/Users/a/Documents/HiveTeX/thesis-2026' : undefined) as T;
    },
    copy: async (t) => {
      calls.push(`copy ${t}`);
    },
  };
  return { d, calls };
}

describe('project folder actions', () => {
  it('creates and binds the default folder first when the project is kept in the app', async () => {
    const { d, calls } = deps(null);
    const r = await runFolderAction(d, { kind: 'open' });
    expect(r).toEqual({ path: 'C:/Users/a/Documents/HiveTeX/thesis-2026', created: true });
    expect(calls).toEqual([
      'mirror_default_folder {"slug":"thesis-2026","projectId":"p1"}',
      'bind C:/Users/a/Documents/HiveTeX/thesis-2026',
      'mirror_open {"id":"p1"}',
    ]);
  });

  it('uses the bound folder as it is', async () => {
    const { d, calls } = deps('D:/papers/thesis');
    await runFolderAction(d, { kind: 'terminal' });
    await runFolderAction(d, { kind: 'copy' });
    await runFolderAction(d, { kind: 'reveal', path: 'sections/intro.tex' });
    expect(calls).toEqual(['mirror_open_terminal {"id":"p1"}', 'copy D:/papers/thesis', 'mirror_reveal {"id":"p1","rel":"sections/intro.tex"}']);
  });

  it('does not run the action when binding fails', async () => {
    const { d, calls } = deps(null);
    d.bind = async () => {
      throw new Error('disk full');
    };
    await expect(runFolderAction(d, { kind: 'terminal' })).rejects.toThrow('disk full');
    expect(calls.some((c) => c.startsWith('mirror_open_terminal'))).toBe(false);
  });
});
