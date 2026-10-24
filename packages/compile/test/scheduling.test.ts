import { afterEach, expect, it, vi } from 'vitest';
import { LocalCompiler } from '../src/local.js';
import type { CompileInput, CompileOutput } from '../src/pipeline.js';

const active: LocalCompiler[] = [];
afterEach(() => { for (const c of active.splice(0)) c.stop(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  let changed = () => {}, available = () => {}, stored = () => {};
  let input: CompileInput = { files: [], main: 'main.tex', engine: 'pdflatex', stateHash: 'initial' };
  const compile = vi.fn(async (_input: CompileInput): Promise<CompileOutput> => ({ ok: true, pdf: new Uint8Array([1]), log: '' }));
  const off = vi.fn();
  const compiler = new LocalCompiler({
    model: { onDocUpdate: (cb: () => void) => { changed = cb; return off; }, onAvailability: (cb: () => void) => { available = cb; return off; } },
    blobs: { onStored: (cb: () => void) => { stored = cb; return off; } },
    mesh: {}, engine: { kind: 'native', supports: ['pdflatex', 'xelatex'], compile }, self: { dev: 'device', uname: 'writer' },
  } as unknown as ConstructorParameters<typeof LocalCompiler>[0]);
  const snapshot = vi.spyOn(compiler, 'snapshot').mockImplementation(async () => ({ ...input }));
  active.push(compiler);
  return { compiler, compile, snapshot, off, available: () => available(), stored: () => stored(), edit: (hash: string) => { input = { ...input, stateHash: hash }; changed(); } };
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

it('debounces at 1500 ms and starts by 5000 ms under continuous changes', async () => {
  const f = fixture();
  f.edit('a'); await advance(1499); expect(f.compile).not.toHaveBeenCalled();
  await advance(1); expect(f.compile).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 5; i++) { f.edit(`burst${i}`); await advance(1000); }
  expect(f.compile).toHaveBeenCalledTimes(2);
  expect(f.compile.mock.calls.at(-1)?.[0]).toMatchObject({ stateHash: 'burst4' });
});

it('periodic checks use the interval and manual suppresses open, changes and ticks', async () => {
  const f = fixture();
  f.compiler.setSchedule('manual'); f.compiler.schedule(0); f.edit('a');
  await advance(60_000); expect(f.compile).not.toHaveBeenCalled();
  f.compiler.setSchedule('periodic', 5);
  await advance(4999); expect(f.compile).not.toHaveBeenCalled();
  await advance(1); expect(f.compile).toHaveBeenCalledTimes(1);
  await advance(20_000); expect(f.compile).toHaveBeenCalledTimes(1);
  f.edit('b'); await advance(5000); expect(f.compile).toHaveBeenCalledTimes(2);
  f.compiler.setSchedule('after-changes'); f.edit('c'); await advance(1500);
  expect(f.compile).toHaveBeenCalledTimes(3);
});

it('coalesces explicit bursts, edits and ticks into one latest build without overlap', async () => {
  const f = fixture();
  let release!: (out: CompileOutput) => void;
  f.compile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = f.compiler.run(); await advance(0);
  const requests = Array.from({ length: 20 }, () => f.compiler.run());
  expect(new Set(requests).size).toBe(1);
  f.compiler.setSchedule('periodic', 5);
  f.edit('latest'); await advance(20_000);
  expect(f.compile).toHaveBeenCalledTimes(1);
  release({ ok: true, pdf: new Uint8Array([1]), log: '' });
  await first; await Promise.all(requests); await advance(0);
  expect(f.compile).toHaveBeenCalledTimes(2);
  expect(f.compile.mock.calls.at(-1)?.[0]).toMatchObject({ stateHash: 'latest' });
  await f.compiler.run(); expect(f.compile).toHaveBeenCalledTimes(2);
});

it('manual cancels automatic waiting work but preserves explicit queued work and the current build', async () => {
  const f = fixture();
  f.edit('cancel debounce'); f.compiler.setSchedule('manual'); await advance(10_000);
  expect(f.compile).not.toHaveBeenCalled();
  let release!: (out: CompileOutput) => void;
  f.compile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = f.compiler.run(); await advance(0);
  f.compiler.setSchedule('after-changes'); f.edit('pending'); await advance(1500);
  expect(f.compiler.waiting).toBe(true);
  f.compiler.setSchedule('manual');
  release({ ok: true, pdf: new Uint8Array([1]), log: '' }); await first; await advance(0);
  expect(f.compile).toHaveBeenCalledTimes(1);
  f.compile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const second = f.compiler.run(); await advance(0);
  f.edit('explicit survives'); const pending = f.compiler.run();
  f.compiler.setSchedule('periodic', 5); f.compiler.setSchedule('manual');
  release({ ok: true, pdf: new Uint8Array([1]), log: '' }); await second; await pending;
  expect(f.compile).toHaveBeenCalledTimes(3);
});

it('does not repeat failed automatic attempts until inputs, availability or compiler change or explicit retry', async () => {
  const f = fixture(); f.compile.mockResolvedValue({ ok: false, log: '! syntax' });
  f.compiler.setSchedule('periodic', 5); await advance(30_000);
  expect(f.compile).toHaveBeenCalledTimes(1);
  await f.compiler.run(); expect(f.compile).toHaveBeenCalledTimes(2);
  f.edit('corrected'); await advance(5000); expect(f.compile).toHaveBeenCalledTimes(3);
  f.available(); await advance(5000); expect(f.compile).toHaveBeenCalledTimes(4);
  f.compiler.compilerSwitched(); await advance(5000); expect(f.compile).toHaveBeenCalledTimes(5);
  await advance(30_000); expect(f.compile).toHaveBeenCalledTimes(5);
});

it('retries incomplete input when a blob arrives and releases every timer/subscription on stop', async () => {
  const f = fixture();
  const { IncompleteInputError } = await import('../src/pipeline.js');
  f.snapshot.mockRejectedValueOnce(new IncompleteInputError([{ path: 'image.png', kind: 'binary' }] as never));
  f.compiler.setSchedule('periodic', 5); await advance(15_000);
  expect(f.snapshot).toHaveBeenCalledTimes(1);
  f.stored(); await advance(5000); expect(f.compile).toHaveBeenCalledTimes(1);
  f.compiler.stop(); f.edit('closed'); f.available(); f.stored(); await advance(60_000);
  expect(f.compile).toHaveBeenCalledTimes(1);
  expect(f.off).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.compiler.run()).rejects.toThrow('detached');
});

it('invalidates unchanged successful inputs after an engine change', async () => {
  const f = fixture(); await f.compiler.run(); await f.compiler.run();
  expect(f.compile).toHaveBeenCalledTimes(1);
  f.compiler.compilerSwitched(); await advance(0);
  expect(f.compile).toHaveBeenCalledTimes(2);
});
