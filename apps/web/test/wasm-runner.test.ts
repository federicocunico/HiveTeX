// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/lib/api.js', () => ({ isDesktop: false, safeStorage: () => null }));
import { Runner, loadWasmEngine } from '../src/lib/wasm-engine.js';
const input = { files: [], main: 'main.tex', engine: 'pdflatex' as const, stateHash: 'state' };
const downloaded = async () => {};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

class Fake {
  static all: Fake[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  posted: Array<{ cmd: string; url?: string }> = [];
  constructor() { Fake.all.push(this); }
  postMessage(m: { cmd: string; url?: string }) { this.posted.push(m); }
  reply(data: unknown) { this.onmessage?.({ data }); }
}
const fakeWorkers = () => {
  Fake.all = [];
  vi.stubGlobal('Worker', Fake);
  return Fake.all;
};

it('bounds silent startup, terminates it, and starts a clean instance on retry', async () => {
  vi.useFakeTimers();
  const workers = fakeWorkers();
  const runner = new Runner('pdflatex', 50, downloaded);
  const first = runner.compile(input, 1000);
  await vi.advanceTimersByTimeAsync(51);
  expect((await first).log).toContain('startup timed out');
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  const retry = runner.compile(input, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(workers).toHaveLength(2);
  workers[1]?.reply({ result: 'ok' });
  await vi.advanceTimersByTimeAsync(0);
  workers[1]?.onerror?.();
  expect((await retry).log).toContain('crashed');
  expect(workers[1]?.terminate).toHaveBeenCalledOnce();
});

it('does not count the .wasm download against the startup deadline', async () => {
  vi.useFakeTimers();
  const workers = fakeWorkers();
  let done: () => void = () => {};
  const runner = new Runner('pdflatex', 50, () => new Promise<void>((r) => { done = r; }));
  const build = runner.compile(input, 10_000);
  // a slow first download (longer than the startup limit) creates no worker and fails nothing
  await vi.advanceTimersByTimeAsync(5_000);
  expect(workers).toHaveLength(0);
  done();
  await vi.advanceTimersByTimeAsync(0);
  expect(workers).toHaveLength(1);
  workers[0]?.reply({ result: 'ok' });
  await vi.advanceTimersByTimeAsync(0);
  workers[0]?.reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(4), log: '' });
  expect((await build).ok).toBe(true);
});

it('a failed download fails the start with its cause and the next build tries again', async () => {
  const workers = fakeWorkers();
  const prepare = vi.fn().mockRejectedValueOnce(new Error('The in-browser compiler could not be downloaded (offline)')).mockResolvedValue(undefined);
  const runner = new Runner('pdflatex', 1000, prepare);
  expect((await runner.compile(input, 1000)).log).toContain('could not be downloaded');
  expect(workers).toHaveLength(0);
  const retry = runner.compile(input, 1000);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  workers[0]?.reply({ result: 'ok' });
  await vi.waitFor(() => expect(workers[0]?.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
  workers[0]?.reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(4), log: '' });
  expect((await retry).ok).toBe(true);
});

it('settles and terminates startup and an active build when cancelled', async () => {
  const workers = fakeWorkers();
  const runner = new Runner('pdflatex', 30_000, downloaded);
  const a = new AbortController();
  const download = runner.compile(input, 1000, a.signal);
  a.abort();
  // cancelled while downloading: settles without ever starting a worker
  expect((await download).ok).toBe(false);
  expect(workers).toHaveLength(0);
  const b = new AbortController();
  const startup = runner.compile(input, 1000, b.signal);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  b.abort();
  expect((await startup).ok).toBe(false);
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  const c = new AbortController();
  const build = runner.compile(input, 1000, c.signal);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  workers[1]?.reply({ result: 'ok' });
  await vi.waitFor(() => expect(workers[1]?.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
  c.abort();
  expect((await build).log).toContain('stopped');
  expect(workers[1]?.terminate).toHaveBeenCalledOnce();
});

it('builds only after every folder and file was confirmed, and a refused write never builds', async () => {
  const workers = fakeWorkers();
  const runner = new Runner('pdflatex', 30_000, downloaded);
  const nested = { ...input, files: [{ path: 'main.tex', kind: 'text' as const, text: 'x' }, { path: 'img/a/b.png', kind: 'binary' as const, bytes: new Uint8Array(1) }] };
  const ack = (w: Fake) => { for (const m of w.posted) if (m.cmd === 'mkdir' || m.cmd === 'writefile') w.reply({ cmd: m.cmd, result: 'ok' }); };
  const first = runner.compile(nested, 1000);
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const w = workers[0] as Fake;
  w.reply({ result: 'ok' });
  await vi.waitFor(() => expect(w.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
  expect(w.posted.filter((m) => m.cmd === 'mkdir').map((m) => m.url)).toEqual(['img', 'img/a']);
  ack(w);
  w.reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(4), log: '' });
  expect((await first).ok).toBe(true);
  // the same file set reuses the worker: its folders exist, so only the files are written again
  w.posted.length = 0;
  const second = runner.compile(nested, 1000);
  await vi.waitFor(() => expect(w.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
  expect(w.posted.filter((m) => m.cmd === 'mkdir')).toEqual([]);
  w.reply({ cmd: 'writefile', result: 'ok' });
  w.reply({ cmd: 'writefile', result: 'failed' });
  const refused = await second;
  expect(refused.ok).toBe(false);
  expect(refused.log).toContain('could not write img/a/b.png');
  expect(w.terminate).toHaveBeenCalledOnce();
  // a build answer before the writes were confirmed is not trusted either
  const third = runner.compile(nested, 1000);
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  const fresh = workers[1] as Fake;
  fresh.reply({ result: 'ok' });
  await vi.waitFor(() => expect(fresh.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
  fresh.reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(4), log: '' });
  expect((await third).log).toContain('did not confirm');
});

it('ten projects opened and closed leave no compiler worker running', async () => {
  const workers = fakeWorkers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  for (let i = 0; i < 10; i++) {
    const engine = await loadWasmEngine(`project-${i}`);
    expect(engine).not.toBeNull();
    const build = engine!.compile(input, { timeoutMs: 30_000 });
    await vi.waitFor(() => expect(workers).toHaveLength(i + 1));
    workers[i]?.reply({ result: 'ok' });
    await vi.waitFor(() => expect(workers[i]?.posted.some((m) => m.cmd === 'compilelatex')).toBe(true));
    workers[i]?.reply({ cmd: 'compile', result: 'ok', status: 0, pdf: new ArrayBuffer(4), log: '' });
    expect((await build).ok).toBe(true);
    expect(workers[i]?.terminate).not.toHaveBeenCalled();
    engine!.dispose?.();
    expect((await engine!.compile(input, { timeoutMs: 30_000 })).log).toContain('closed');
  }
  expect(workers).toHaveLength(10);
  for (const w of workers) expect(w.terminate).toHaveBeenCalledOnce();
});

it('an unreachable TeX file server is checked again shortly, not remembered for ten minutes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  sessionStorage.clear();
  const { texServerReachable } = await import('../src/lib/wasm-engine.js');
  const fetch = vi.fn(async () => ({ ok: false }));
  vi.stubGlobal('fetch', fetch);
  expect(await texServerReachable()).toBe(false);
  expect(await texServerReachable()).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 20_000);
  fetch.mockResolvedValue({ ok: true });
  expect(await texServerReachable()).toBe(true);
  vi.setSystemTime(Date.now() + 5 * 60_000);
  expect(await texServerReachable()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
