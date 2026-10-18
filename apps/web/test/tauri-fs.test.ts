import { expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === 'mirror_write' || cmd === 'mirror_remove') return '.hivetex-recovery/main.tex.0123456789abcdef0123456789abcdef.retained';
  return null;
}));
const listeners = vi.hoisted(() => [] as Array<(e: { payload: string }) => void>);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name: string, cb: (e: { payload: string }) => void) => { listeners.push(cb); return () => {}; }) }));
import { tauriFs } from '../src/lib/tauri-fs.js';

it('returns the transient retained copy, drops it through its own command and maps watcher errors', async () => {
  const fs = await tauriFs('p', 'C:/papers/thesis');
  const copy = await fs.write('main.tex', new TextEncoder().encode('x'));
  expect(copy).toMatch(/^\.hivetex-recovery\/main\.tex\.[0-9a-f]{32}\.retained$/);
  expect(await fs.remove('main.tex')).toBe(copy);
  await fs.dropRetained!(copy as string);
  expect(invoke).toHaveBeenCalledWith('mirror_drop_retained', { id: 'p', path: copy });
  const seen: Array<{ path: string; error?: unknown }> = [];
  fs.watch((ev) => seen.push(ev));
  await vi.waitFor(() => expect(listeners).toHaveLength(1));
  listeners[0]!({ payload: 'figs/a.png' });
  listeners[0]!({ payload: '\0error:watch lost' });
  expect(seen).toEqual([{ path: 'figs/a.png' }, { path: '', error: 'watch lost' }]);
});
