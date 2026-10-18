// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Compiler status follows the engine builds use (compiler-provisioning), and the session's engine ends with it. */
const helper = vi.hoisted(() => ({ paired: false }));
vi.mock('../src/lib/helper-engine.js', () => ({
  helperToken: () => (helper.paired ? { port: 47812, token: 't'.repeat(64) } : null),
  probeHelper: async () => ({ port: 47812, compiler: 'texlive', supports: ['pdflatex'], verifiedReads: true }),
  pairWithDesktop: async () => { helper.paired = true; return 'paired'; },
  HelperEngine: class {
    readonly kind = 'native';
    readonly flavor = 'texlive';
    readonly verifiedReads = true;
    readonly supports = ['pdflatex'];
    async compile() { return { ok: false, log: '' }; }
  },
}));
import { ProjectSession } from '../src/lib/session.svelte.js';
import StatusBar from '../src/components/workspace/StatusBar.svelte';

const project = { id: 'p-status', slug: 'status', role: 'owner' as const, defaultRole: 'viewer', passwordProtected: false, epoch: 1 };
const user = { id: 'u1', username: 'alice' };
const flush = async () => { await tick(); await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  helper.paired = false;
  localStorage.clear();
});

describe('compiler status', () => {
  it('names the paired desktop helper without a reload and stops offering setup', async () => {
    const s = new ProjectSession(project, user);
    render(StatusBar, { props: { session: s } });
    expect(screen.getByTestId('compile-location').textContent).toBe('Set up a local compiler');
    expect(await s.pairDesktopHelper()).toBe('paired');
    await flush();
    expect(screen.getByTestId('compile-location').textContent).toBe('Compiles on this device');
    expect(screen.getByTestId('compiler-state').textContent).toContain('desktop app (TeX Live)');
    expect(screen.getByTestId('statusbar').textContent).not.toContain('Set up a local compiler');
  });

  it('keeps the migration notice of a session closed at once, offers local setup, and forgets it only when dismissed', async () => {
    localStorage.setItem('hivetex.compileMode', 'peers');
    const closedAtOnce = new ProjectSession(project, user);
    expect(closedAtOnce.compileMigrationNotice).toBe(true);
    await closedAtOnce.close();
    const s = new ProjectSession(project, user);
    render(StatusBar, { props: { session: s } });
    expect(screen.getByTestId('compile-migration').textContent).toContain('Shared compilation was removed');
    expect(screen.getByTestId('compile-migration-setup').textContent).toBe('Set up a local compiler');
    await s.pairDesktopHelper();
    await flush();
    // a usable compiler: nothing to set up, the explanation stays until dismissed
    expect(screen.queryByTestId('compile-migration-setup')).toBeNull();
    screen.getByTestId('compile-migration-dismiss').click();
    await flush();
    expect(screen.queryByTestId('compile-migration')).toBeNull();
    expect(new ProjectSession(project, user).compileMigrationNotice).toBe(false);
  });

  it('closing a session releases its compiler engine', async () => {
    const dispose = vi.fn();
    for (let i = 0; i < 10; i++) {
      const s = new ProjectSession({ ...project, id: `p-${i}` }, user);
      s.engine = { kind: 'wasm', supports: ['pdflatex'], compile: async () => ({ ok: false, log: '' }), dispose };
      await s.close();
      expect(s.engine).toBeNull();
    }
    expect(dispose).toHaveBeenCalledTimes(10);
  });
});
