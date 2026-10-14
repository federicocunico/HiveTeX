// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../src/lib/api.js', () => ({ isDesktop: true, safeStorage: () => null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
import { clearTexCache, loadWasmEngine } from '../src/lib/wasm-engine.js';

afterEach(() => vi.unstubAllGlobals());

it('reset refuses active builds, preserves workers on failure and resets reused workers on every successful clear', async () => {
  let started: () => void = () => {};
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    terminate = vi.fn();
    constructor() {
      workers.push(this);
      queueMicrotask(() => this.onmessage?.({ data: { result: 'ok' } }));
    }
    postMessage(message: { cmd: string }) { if (message.cmd === 'compilelatex') started(); }
    finish() { this.onmessage?.({ data: { cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(4), status: 0 } }); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  const engine = await loadWasmEngine('project');
  expect(engine).not.toBeNull();
  const input = { files: [], main: 'main.tex', engine: 'pdflatex' as const, stateHash: 'state' };
  const compile = async () => {
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const build = engine!.compile(input, { timeoutMs: 30_000 });
    await ready;
    return { build };
  };
  const { build } = await compile();
  await expect(clearTexCache(true)).rejects.toThrow('activity');
  expect(workers[0].terminate).not.toHaveBeenCalled();
  workers[0].finish();
  expect((await build).ok).toBe(true);

  invoke.mockRejectedValueOnce(new Error('locked cache file'));
  await expect(clearTexCache(true)).rejects.toThrow('locked cache file');
  expect(workers[0].terminate).not.toHaveBeenCalled();
  await clearTexCache(true);
  expect(invoke).toHaveBeenLastCalledWith('compiler_cache_clear');
  expect(workers[0].terminate).toHaveBeenCalledOnce();

  const second = await compile();
  workers[1].finish();
  await second.build;
  await clearTexCache(true);
  expect(workers[1].terminate).toHaveBeenCalledOnce();
});
