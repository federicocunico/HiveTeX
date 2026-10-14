import { ROOT_DOC_ID } from '@hivetex/protocol';
import { BlobManager } from '@hivetex/sync';
import { type Node, Net } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CompileEngine,
  type CompileInput,
  CompileClient,
  CompileLeader,
  Election,
  computeStateHash,
} from '../src/index.js';

let net: Net;
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  net?.destroy();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

class FakeEngine implements CompileEngine {
  kind = 'native' as const;
  supports = ['pdflatex', 'xelatex'] as ('pdflatex' | 'xelatex')[];
  calls: CompileInput[] = [];
  delayMs = 0;
  async compile(input: CompileInput) {
    this.calls.push(input);
    if (this.delayMs) await sleep(this.delayMs);
    const main = input.files.find((f) => f.path === input.main)?.text ?? '';
    if (main.includes('\\boom')) {
      return { ok: false, log: `(./main.tex\n! Undefined control sequence.\nl.2 \\boom\n\n)\n` };
    }
    return { ok: true, pdf: new TextEncoder().encode(`%PDF-fake ${input.stateHash}\n${main}`), synctex: new TextEncoder().encode('synctex'), log: 'ok' };
  }
}

interface Dev {
  node: Node;
  election: Election;
  blobs: BlobManager;
  client: CompileClient;
  leader: CompileLeader;
  engine: FakeEngine;
}

async function device(name: string, role: 'owner' | 'editor' | 'viewer', perf: number, opts: { debounce?: number; assetTimeoutMs?: number; retryMs?: number } = {}): Promise<Dev> {
  const node = await net.add(name, role);
  const blobs = new BlobManager(node.mesh, node.store);
  const election = new Election(
    node.mesh,
    { dev: node.dev, uname: name, engine: 'native', supports: ['pdflatex', 'xelatex'], perf, power: 'mains', batteryPct: 100, load: 0, optOut: false },
    { engine: () => 'pdflatex', selfRole: role, intervalMs: 100 }, // 300 ms to declare a peer gone: tolerant of slow CI runners
  );
  const engine = new FakeEngine();
  const leader = new CompileLeader({
    mesh: node.mesh,
    model: node.model,
    blobs,
    election,
    engine,
    self: { dev: node.dev, uname: name },
    debounceMs: opts.debounce ?? 60,
    maxWaitMs: 400,
    settleMs: 400,
    assetTimeoutMs: opts.assetTimeoutMs ?? 300,
    retryMs: opts.retryMs ?? 300,
  });
  const client = new CompileClient({ mesh: node.mesh, model: node.model, blobs, election, leader });
  election.start();
  stops.push(() => election.stop());
  return { node, election, blobs, client, leader, engine };
}

const pdfText = (d: Dev) => (d.client.lastGood ? new TextDecoder().decode(d.client.lastGood.pdf) : '');

describe('foreground detach with a retained mesh', () => {
  it('aborts an in-flight build, publishes no late result, and schedules nothing on later seed edits', async () => {
    net = await Net.create();
    const d = await device('foreground', 'owner', 3);
    const id = await d.node.model.createTextNow('main.tex', 'first');
    let release!: () => void;
    let signal: AbortSignal | undefined;
    let calls = 0;
    d.engine.compile = async (_input, opts?: { signal?: AbortSignal }) => {
      calls++;
      signal = opts?.signal;
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, pdf: new Uint8Array([1]), synctex: new Uint8Array([2]), log: 'late' };
    };
    await waitFor(() => calls === 1);
    d.leader.stop(); d.client.stop(); d.election.stop();
    expect(signal?.aborted).toBe(true);
    release();
    (await d.node.model.openText(id)).insert(0, 'seed edit ');
    await sleep(100);
    await expect.poll(async () => calls, { timeout: 15_000 }).toBe(1);
    expect(d.leader.lastResult).toBeNull();
    expect(d.client.lastGood).toBeNull();
    expect(await d.leader.run()).toBeNull();
  });
});

describe('compile pipeline (8.3)', () => {
  it('compiles after typing pauses on the leader only, and every member receives the PDF', async () => {
    net = await Net.create();
    const [big, small, viewer] = [await device('big', 'owner', 3), await device('small', 'editor', 1), await device('vic', 'viewer', 8)];
    await net.fullMesh();
    await waitFor(() => [big, small, viewer].every((d) => d.election.leader() === big.node.dev));

    await small.node.model.createTextNow('main.tex', '\\documentclass{article} hello');
    await waitFor(() => [big, small, viewer].every((d) => pdfText(d).includes('hello')));
    expect(big.engine.calls.length).toBeGreaterThan(0);
    expect(small.engine.calls.length).toBe(0);
    expect(viewer.engine.calls.length).toBe(0);
    expect(viewer.client.latest?.by.uname).toBe('big');
  });

  it('debounces bursts of typing into a single compile', async () => {
    net = await Net.create();
    const [big, small] = [await device('big', 'owner', 3, { debounce: 120 }), await device('small', 'editor', 1)];
    await net.link(big.node, small.node);
    await waitFor(() => small.election.leader() === big.node.dev);
    const id = await small.node.model.createTextNow('main.tex', 'a');
    await waitFor(() => pdfText(small).includes('a'));
    const before = big.engine.calls.length;
    const t = await small.node.model.openText(id);
    for (let i = 0; i < 15; i++) {
      t.insert(t.length, 'x');
      await sleep(10);
    }
    await waitFor(() => pdfText(small).includes('x'.repeat(15)));
    expect(big.engine.calls.length - before).toBeLessThanOrEqual(2);
  });

  it('queues exactly one follow-up when edits arrive during a running compile', async () => {
    net = await Net.create();
    const [big] = [await device('big', 'owner', 3)];
    big.engine.delayMs = 150;
    await waitFor(() => big.election.isLeader());
    const id = await big.node.model.createTextNow('main.tex', 'v1');
    await waitFor(() => big.engine.calls.length === 1);
    const t = await big.node.model.openText(id);
    t.insert(2, 'a');
    await sleep(100);
    t.insert(3, 'b');
    await sleep(100);
    t.insert(4, 'c');
    await waitFor(() => (big.leader.lastResult?.stateHash ?? '') === '' ? false : big.engine.calls.length >= 2 && !!big.leader.lastResult);
    await sleep(500);
    expect(big.engine.calls.length).toBeLessThanOrEqual(3);
    expect(big.engine.calls.at(-1)?.files[0]?.text).toBe('v1abc');
  });

  it('keeps the last good PDF and shares diagnostics when the source breaks', async () => {
    net = await Net.create();
    const [big, small] = [await device('big', 'owner', 3), await device('small', 'editor', 1)];
    await net.link(big.node, small.node);
    await waitFor(() => small.election.leader() === big.node.dev);
    const id = await small.node.model.createTextNow('main.tex', 'good document');
    await waitFor(() => pdfText(small).includes('good document'));
    (await small.node.model.openText(id)).insert(0, '\\boom ');
    await waitFor(() => small.client.latest?.ok === false);
    expect(small.client.latest?.diagnostics[0]).toMatchObject({ severity: 'error', line: 2, file: 'main.tex' });
    expect(pdfText(small)).toContain('good document'); // previous PDF still shown
  });

  it('detects stale previews and clears the flag when the new PDF arrives', async () => {
    net = await Net.create();
    const [big, small] = [await device('big', 'owner', 3, { debounce: 200 }), await device('small', 'editor', 1)];
    await net.link(big.node, small.node);
    await waitFor(() => small.election.leader() === big.node.dev);
    const id = await small.node.model.createTextNow('main.tex', 'one');
    await waitFor(() => pdfText(small).includes('one'));
    expect(await small.client.isStale()).toBe(false);
    (await small.node.model.openText(id)).insert(3, ' two');
    expect(await small.client.isStale()).toBe(true);
    await waitFor(() => pdfText(small).includes('two'));
    expect(await small.client.isStale()).toBe(false);
    expect(await computeStateHash(small.node.model)).toBe(small.client.lastGood?.result.stateHash);
  });

  it('hands over to the next best device when the leader leaves, and compiles there', async () => {
    net = await Net.create();
    const [big, mid] = [await device('big', 'owner', 3), await device('mid', 'editor', 2)];
    await net.link(big.node, mid.node);
    await waitFor(() => mid.election.leader() === big.node.dev);
    const id = await mid.node.model.createTextNow('main.tex', 'before');
    await waitFor(() => pdfText(mid).includes('before'));
    big.election.stop();
    net.isolate(big.node);
    await waitFor(() => mid.election.isLeader());
    (await mid.node.model.openText(id)).insert(6, ' after');
    await waitFor(() => pdfText(mid).includes('after'));
    expect(mid.engine.calls.length).toBeGreaterThan(0);
  });
});

describe('manual compile (8.8)', () => {
  it('honours a recompile request from a viewer', async () => {
    net = await Net.create();
    const [big, vic] = [await device('big', 'owner', 3), await device('vic', 'viewer', 1)];
    await net.link(big.node, vic.node);
    await waitFor(() => vic.election.leader() === big.node.dev);
    await big.node.model.createTextNow('main.tex', 'content');
    await waitFor(() => pdfText(vic).includes('content'));
    const calls = big.engine.calls.length;
    big.engine.delayMs = 0;
    // force a different state so the cache of the last good compile does not short-circuit
    big.leader.lastResult = null;
    vic.client.requestCompile();
    await waitFor(() => big.engine.calls.length > calls);
  });

  it('throttles recompile floods from one peer and re-sends the result when nothing changed (security)', async () => {
    net = await Net.create();
    const [big, vic] = [await device('big', 'owner', 3), await device('vic', 'viewer', 1)];
    await net.link(big.node, vic.node);
    await waitFor(() => vic.election.leader() === big.node.dev);
    await big.node.model.createTextNow('main.tex', 'content');
    await waitFor(() => pdfText(vic).includes('content'));
    big.engine.delayMs = 0;
    let snapshots = 0;
    const orig = big.leader.snapshot.bind(big.leader);
    big.leader.snapshot = async () => {
      snapshots++;
      return orig();
    };
    const calls = big.engine.calls.length;
    vic.client.latest = null; // pretend the viewer lost its copy
    for (let i = 0; i < 200; i++) vic.client.requestCompile();
    await waitFor(() => (vic.client as { latest: unknown }).latest !== null);
    await sleep(300);
    await expect.poll(async () => snapshots, { timeout: 15_000 }).toBe(1); // 200 requests, one honored
    expect(big.engine.calls.length).toBe(calls); // unchanged state: no rebuild
    const latest = () => vic.client.latest; // (re-read: TS narrowed it to null above)
    expect(latest()?.by.uname).toBe('big'); // ...but the requester got the current result
  });

  it('builds an unchanged project again once after the device switched compilers (desktop app paired)', async () => {
    net = await Net.create();
    const big = await device('big', 'owner', 3);
    await waitFor(() => big.election.leader() === big.node.dev);
    await big.node.model.createTextNow('main.tex', 'content');
    await waitFor(() => !!big.leader.lastResult?.ok);
    const calls = big.engine.calls.length;
    await big.leader.run();
    expect(big.engine.calls.length).toBe(calls); // unchanged: the previous result stands
    big.leader.compilerSwitched();
    await big.leader.run();
    expect(big.engine.calls.length).toBe(calls + 1); // the new compiler builds it
    await big.leader.run();
    expect(big.engine.calls.length).toBe(calls + 1); // ...once
  });

  it('compiles locally on a non-leader without distributing the result (also offline)', async () => {
    net = await Net.create();
    const small = await device('small', 'editor', 1);
    small.node.model.markComplete(ROOT_DOC_ID); // created here: its file list is complete
    await small.node.model.createTextNow('main.tex', 'offline draft');
    const r = await small.leader.compileLocally();
    expect(r.result.ok).toBe(true);
    expect(new TextDecoder().decode(r.pdf)).toContain('offline draft');
    expect(small.leader.lastResult?.seq ?? 0).toBeLessThanOrEqual(1);
  });

  it('refuses a local compile when the device lacks the project engine', async () => {
    net = await Net.create();
    const d = await device('d', 'editor', 1);
    d.node.model.markComplete(ROOT_DOC_ID);
    d.engine.supports = ['pdflatex'];
    d.node.model.settings.set('engine', 'lualatex');
    await expect(d.leader.compileLocally()).rejects.toThrow(/cannot run lualatex/);
  });

  it('rejects results published by a viewer or by a non-leader', async () => {
    net = await Net.create();
    const [big, small, vic] = [await device('big', 'owner', 3), await device('small', 'editor', 1), await device('vic', 'viewer', 1)];
    await net.fullMesh();
    await waitFor(() => [big, small, vic].every((d) => d.election.leader() === big.node.dev));
    vic.node.mesh.broadcastApp('compiled', { stateHash: 'x', ok: true, pdfHash: 'f'.repeat(64), diagnostics: [], log: '', by: { dev: vic.node.dev, uname: 'vic' }, at: 1, seq: 99 });
    small.node.mesh.broadcastApp('compiled', { stateHash: 'y', ok: true, pdfHash: 'e'.repeat(64), diagnostics: [], log: '', by: { dev: small.node.dev, uname: 'small' }, at: 1, seq: 99 });
    await sleep(100);
    await expect.poll(async () => big.client.latest === null || big.client.latest.by.dev === big.node.dev, { timeout: 15_000 }).toBe(true);
    expect(big.client.latest?.seq).not.toBe(99);
  });
});

describe('complete immutable inputs and result identity (8.2, F14)', () => {
  const lastCall = (d: Dev) => d.engine.calls[d.engine.calls.length - 1] as CompileInput;

  it('rebuilds when only the engine or the main file changes, and the result says which settings it used', async () => {
    net = await Net.create();
    const [big, small] = [await device('big', 'owner', 3), await device('small', 'editor', 1)];
    await net.link(big.node, small.node);
    await waitFor(() => small.election.leader() === big.node.dev);
    await big.node.model.createTextNow('main.tex', 'first doc');
    await big.node.model.createTextNow('other.tex', 'second doc');
    await waitFor(() => pdfText(small).includes('first doc'));
    const h1 = small.client.lastGood?.result.stateHash;
    const calls = big.engine.calls.length;

    big.node.model.settings.set('engine', 'xelatex');
    await waitFor(() => big.engine.calls.length > calls);
    expect(lastCall(big).engine).toBe('xelatex');
    await waitFor(() => small.client.lastGood?.result.stateHash !== h1);
    const h2 = small.client.lastGood?.result.stateHash;
    expect(await small.client.isStale()).toBe(false);

    big.node.model.settings.set('main', 'other.tex');
    await waitFor(() => pdfText(small).includes('second doc'));
    expect(lastCall(big).main).toBe('other.tex');
    expect(small.client.lastGood?.result.stateHash).not.toBe(h2);
    expect(await computeStateHash(small.node.model)).toBe(small.client.lastGood?.result.stateHash);
  });

  it('counts a settings-only change as stale before it is rebuilt', async () => {
    net = await Net.create();
    const [big, small] = [await device('big', 'owner', 3, { debounce: 2000 }), await device('small', 'editor', 1)];
    await net.link(big.node, small.node);
    await waitFor(() => small.election.leader() === big.node.dev);
    await small.node.model.createTextNow('main.tex', 'one');
    await waitFor(() => pdfText(small).includes('one'), 8000);
    expect(await small.client.isStale()).toBe(false);
    small.node.model.settings.set('engine', 'xelatex');
    expect(await small.client.isStale()).toBe(true);
  });

  it('identifies the bytes it compiled when text changes while a later asset is still being fetched', async () => {
    net = await Net.create();
    const big = await device('big', 'owner', 3);
    await waitFor(() => big.election.isLeader());
    const hash = await big.blobs.add(new TextEncoder().encode('PNG'));
    // zzz.png sorts after main.tex: its fetch starts after the text was captured
    const id = await big.node.model.createTextNow('main.tex', 'captured text');
    big.node.model.createBinary('zzz.png', hash, 3);
    const hashAtCapture = await computeStateHash(big.node.model);
    const real = big.blobs.fetch.bind(big.blobs);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let fetching = false;
    big.blobs.fetch = async (h, t) => {
      fetching = true;
      await gate;
      return real(h, t);
    };
    await waitFor(() => fetching);
    (await big.node.model.openText(id)).insert(0, 'LATER ');
    const hashAfterEdit = await computeStateHash(big.node.model);
    expect(hashAfterEdit).not.toBe(hashAtCapture);
    release();
    await waitFor(() => big.leader.lastResult !== null);
    const first = big.engine.calls[0] as CompileInput;
    expect(first.files.find((f) => f.path === 'main.tex')?.text).toBe('captured text');
    expect(first.stateHash).toBe(hashAtCapture);
    expect(big.leader.lastResult?.stateHash).toBe(hashAtCapture);
    // the later edit makes that result stale and is built afterwards
    await waitFor(() => big.leader.lastResult?.stateHash === hashAfterEdit);
    expect(lastCall(big).files.find((f) => f.path === 'main.tex')?.text).toBe('LATER captured text');
  });

  it('reports unavailable inputs instead of compiling empty stand-ins, and builds once they arrive', async () => {
    net = await Net.create();
    const big = await device('big', 'owner', 3);
    await waitFor(() => big.election.isLeader());
    await big.node.model.createTextNow('main.tex', 'real');
    await waitFor(() => big.engine.calls.length === 1);
    big.node.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' }); // listed, body never received
    await waitFor(() => big.leader.lastIncomplete !== null, 8000);
    expect(big.leader.lastIncomplete).toMatchObject({ ok: false, incomplete: ['ghost.tex'] });
    expect(big.engine.calls.length).toBe(1);
    expect(big.leader.lastResult?.incomplete).toBeUndefined(); // the last successful build is not replaced
    await expect(big.leader.compileLocally()).rejects.toThrow(/ghost\.tex/);
    // content arrives (here: the file is created with its text)
    big.node.model.markComplete('f:ghost');
    await waitFor(() => big.engine.calls.length === 2, 8000);
    expect(lastCall(big).files.map((f) => f.path)).toContain('ghost.tex');
    expect(big.leader.lastIncomplete).toBeNull();
  });

  it('reports a missing image instead of building without it', async () => {
    net = await Net.create();
    const big = await device('big', 'owner', 3);
    await waitFor(() => big.election.isLeader());
    await big.node.model.createTextNow('main.tex', 'with figure');
    big.node.model.createBinary('fig.png', 'a'.repeat(64), 3);
    await expect(big.leader.compileLocally()).rejects.toThrow(/fig\.png/);
  });
});
