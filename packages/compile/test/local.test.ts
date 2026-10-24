import { BlobManager, sha256Hex } from '@hivetex/sync';
import { Net, waitFor } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CompileEngine, type CompileInput, LocalCompiler, computeStateHash } from '../src/index.js';

let net: Net;
const compilers: LocalCompiler[] = [];
afterEach(async () => {
  for (const c of compilers.splice(0)) c.stop();
  net?.destroy();
  for (const n of net?.nodes ?? []) await n.model.destroy();
});

async function device(name = 'alice', automatic = false, options: Partial<ConstructorParameters<typeof LocalCompiler>[0]> = {}) {
  net ??= await Net.create();
  const n = await net.add(name, 'owner');
  const id = await n.model.createTextNow('main.tex', 'initial');
  const calls: CompileInput[] = [];
  const engine: CompileEngine = {
    kind: 'native', supports: ['pdflatex', 'xelatex'],
    compile: async (input) => {
      calls.push(input);
      return input.files.some((f) => f.text?.includes('bad')) ? { ok: false, log: '! invalid source' }
        : { ok: true, pdf: new TextEncoder().encode(`%PDF ${name} ${input.stateHash}`), synctex: new TextEncoder().encode('mapping'), log: 'ok' };
    },
  };
  const blobs = new BlobManager(n.mesh, n.store);
  const compiler = new LocalCompiler({ mesh: n.mesh, model: n.model, blobs, engine, self: { dev: n.dev, uname: name }, automatic: () => automatic, debounceMs: 10, ...options });
  compilers.push(compiler);
  return { n, id, engine, calls, compiler, blobs };
}

describe('exclusively local compilation', () => {
  it('refuses ambiguous host paths instead of silently compiling overwritten inputs, and recovers after rename', async () => {
    net = await Net.create(); const d = await device(); const good = await d.compiler.run();
    await d.n.model.createTextNow('Intro.tex','uppercase'); const lower = await d.n.model.createTextNow('intro.tex','lowercase');
    const failed = await d.compiler.run();
    expect(failed.result.ok).toBe(false); expect(failed.result.log).toContain('ambiguous file paths');
    expect(d.compiler.lastGood).toBe(good); expect(d.calls).toHaveLength(1);
    d.n.model.rename(lower,'renamed.tex'); expect((await d.compiler.run()).result.ok).toBe(true);
    expect(d.calls.at(-1)?.files.find((f) => f.path === 'Intro.tex')?.text).toBe('uppercase');
    expect(d.calls.at(-1)?.files.find((f) => f.path === 'renamed.tex')?.text).toBe('lowercase');
  });
  it('syncs an uploaded PDF input but never announces or serves a generated PDF or SyncTeX', async () => {
    net = await Net.create();
    const a = await device('alice'), b = await device('bob');
    const input = new TextEncoder().encode('%PDF uploaded figure');
    const inputHash = await a.blobs.add(input);
    const id = a.n.model.createBinary('figure.pdf', inputHash, input.length);
    const announcements: string[] = [];
    b.blobs.onAnnounced((_, hashes) => announcements.push(...hashes));
    await net.link(a.n, b.n);
    await waitFor(() => b.n.model.byId(id)?.hash === inputHash);
    expect(await b.blobs.fetch(inputHash, 1000)).toEqual(input);
    const result = await a.compiler.run();
    const pdfHash = await sha256Hex(result.pdf!);
    const synctexHash = await sha256Hex(result.synctex!);
    expect(await a.n.store.listBlobs()).toEqual([inputHash]);
    expect(announcements).toContain(inputHash);
    expect(announcements).not.toContain(pdfHash); expect(announcements).not.toContain(synctexHash);
    await expect(b.blobs.fetch(pdfHash, 30)).rejects.toThrow();
    expect(await b.n.store.listBlobs()).toEqual([inputHash]);
  });
  it('captures exact source bytes before waiting for an asset and leaves the result stale after a later edit', async () => {
    net = await Net.create();
    const d = await device();
    const hash = await d.blobs.add(new TextEncoder().encode('image'));
    d.n.model.createBinary('image.png', hash, 5);
    const captured = await computeStateHash(d.n.model);
    const capturedSeq = d.n.model.changeSeq;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const fetch = d.blobs.fetch.bind(d.blobs);
    let waiting = false;
    d.blobs.fetch = async (h, t) => { waiting = true; await gate; return fetch(h, t); };
    const build = d.compiler.run();
    await waitFor(() => waiting);
    (await d.n.model.openText(d.id)).insert(0, 'later ');
    release();
    const result = await build;
    expect(d.calls[0]?.files.find((f) => f.path === 'main.tex')?.text).toBe('initial');
    expect(result.result.stateHash).toBe(captured);
    expect(result.source).toMatchObject({ seq: capturedSeq, stateHash: captured, engine: 'pdflatex' });
    expect(await d.compiler.isStale()).toBe(true);
  });

  it('reports unknown text and a missing image without compiling stand-ins, then recovers', async () => {
    net = await Net.create();
    const d = await device('alice', false, { assetTimeoutMs: 20 });
    const good = await d.compiler.run();
    d.n.model.putEntry('unknown', { path: 'unknown.tex', kind: 'text' });
    expect((await d.compiler.run()).result.incomplete).toContain('unknown.tex');
    expect(d.calls).toHaveLength(1);
    expect(d.compiler.lastGood).toBe(good);
    d.n.model.markComplete('f:unknown');
    await d.compiler.run();
    d.n.model.createBinary('missing.png', 'a'.repeat(64), 9);
    const failure = await d.compiler.run();
    expect(failure.result.incomplete).toContain('missing.png');
    expect(d.calls).toHaveLength(2);
  });

  it('builds the selected main file and invalidates an unchanged source after a compiler switch', async () => {
    net = await Net.create();
    const d = await device();
    await d.n.model.createTextNow('other.tex', 'other');
    const first = await d.compiler.run();
    d.n.model.settings.set('main', 'other.tex');
    expect(await d.compiler.isStale()).toBe(true);
    const second = await d.compiler.run();
    expect(second.result.stateHash).not.toBe(first.result.stateHash);
    expect(d.calls[1]?.main).toBe('other.tex');
    d.compiler.compilerSwitched();
    await d.compiler.run();
    expect(d.calls).toHaveLength(3);
    d.n.model.settings.set('engine', 'lualatex');
    expect((await d.compiler.run()).result.log).toContain('cannot run lualatex');
    expect(d.calls).toHaveLength(3);
  });

  it('aborts a detached foreground compiler and does not schedule work for later seed edits', async () => {
    net = await Net.create();
    const d = await device('alice', true);
    let signal: AbortSignal | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const compile = d.engine.compile;
    d.engine.compile = async (input, opts) => { signal = opts.signal; const output = await compile(input, opts); await gate; return output; };
    const running = d.compiler.run();
    await waitFor(() => !!signal);
    const rejected = expect(running).rejects.toThrow();
    d.compiler.stop();
    expect(signal?.aborted).toBe(true);
    release();
    await rejected;
    (await d.n.model.openText(d.id)).insert(0, 'seed ');
    await new Promise((r) => setTimeout(r, 40));
    expect(d.calls).toHaveLength(1);
    expect(d.compiler.latest).toBeNull();
  });

  it('builds without a leader and never publishes generated data on sync', async () => {
    net = await Net.create();
    const d = await device();
    const send = vi.spyOn(d.n.mesh, 'broadcastApp');
    const build = await d.compiler.run();
    expect(build.result.ok).toBe(true);
    expect(new TextDecoder().decode(build.pdf)).toContain('%PDF alice');
    expect(build.synctex).toBeDefined();
    expect(send).not.toHaveBeenCalled();
    expect(await d.n.store.listBlobs()).toEqual([]);
    expect(await d.compiler.isStale()).toBe(false);
    expect(await d.compiler.run()).toBe(build);
    expect(d.calls).toHaveLength(1);
  });

  it('debounces edits and invalidates local results when engine settings change', async () => {
    net = await Net.create();
    const d = await device('alice', true);
    const text = await d.n.model.openText(d.id);
    text.insert(text.length, ' one'); text.insert(text.length, ' two');
    await waitFor(() => d.compiler.latest?.result.ok === true);
    expect(d.calls).toHaveLength(1);
    d.n.model.settings.set('engine', 'xelatex');
    expect(await d.compiler.isStale()).toBe(true);
    await waitFor(() => d.calls.length === 2);
    expect(d.calls[1]?.engine).toBe('xelatex');
  });

  it('coalesces requests and builds edits made during acquisition/execution afterwards', async () => {
    net = await Net.create();
    const d = await device();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const compile = d.engine.compile;
    d.engine.compile = async (input, opts) => { const out = await compile(input, opts); await gate; return out; };
    const first = d.compiler.run();
    await waitFor(() => d.calls.length === 1);
    (await d.n.model.openText(d.id)).insert(0, 'new ');
    const rest = [d.compiler.run(), d.compiler.run()];
    release();
    await Promise.all([first, ...rest]);
    expect(d.calls).toHaveLength(2);
    expect(d.calls[1]?.files[0]?.text).toBe('new initial');
    expect(await d.compiler.isStale()).toBe(false);
  });

  it('keeps the last good local PDF after a source failure and retries corrected input', async () => {
    net = await Net.create();
    const d = await device();
    const good = await d.compiler.run();
    (await d.n.model.openText(d.id)).insert(0, 'bad ');
    expect((await d.compiler.run()).result.ok).toBe(false);
    expect(d.compiler.lastGood).toBe(good);
    expect(await d.compiler.isStale()).toBe(true);
    (await d.n.model.openText(d.id)).delete(0, 4);
    expect((await d.compiler.run()).result.ok).toBe(true);
  });

  it('ignores old peer build requests/results while independently building on both devices', async () => {
    net = await Net.create();
    const a = await device('alice'), b = await device('bob');
    b.engine.kind = 'wasm';
    await net.link(a.n, b.n);
    await b.n.mesh.sendApp(a.n.dev, 'compile-request', {});
    await b.n.mesh.sendApp(a.n.dev, 'compiled', { ok: true, pdfHash: 'untrusted' });
    await Promise.all([a.compiler.run(), b.compiler.run()]);
    expect(a.compiler.latest?.result.by.uname).toBe('alice');
    expect(b.compiler.latest?.result.by.uname).toBe('bob');
    expect(a.calls).toHaveLength(1); expect(b.calls).toHaveLength(1);
    expect(await a.n.store.listBlobs()).toEqual([]);
    expect(await b.n.store.listBlobs()).toEqual([]);
  });

  it('allows a viewer to build its received sources locally and reuse them after the writer disconnects', async () => {
    net = await Net.create(); const a = await device('alice');
    const viewer = await net.add('viewer', 'viewer');
    const blobs = new BlobManager(viewer.mesh, viewer.store);
    const engine: CompileEngine = { kind: 'wasm', supports: ['pdflatex'], compile: async () => ({ ok: true, pdf: new TextEncoder().encode('%PDF viewer'), log: '' }) };
    const compiler = new LocalCompiler({ model: viewer.model, mesh: viewer.mesh, blobs, engine, self: { dev: viewer.dev, uname: 'viewer' }, automatic: () => false });
    compilers.push(compiler); await net.link(a.n, viewer);
    await waitFor(() => !!viewer.model.byId(a.id));
    const result = await compiler.run(); expect(result.result.by.uname).toBe('viewer'); expect(result.result.ok).toBe(true);
    net.isolate(a.n); expect((await compiler.run()).result.ok).toBe(true);
    expect(await viewer.store.listBlobs()).toEqual([]);
  });
});
