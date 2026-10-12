import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFrame, FrameReader, MAX_FRAME, ProtocolError, RpcEndpoint, validateMessage } from '../src/worker-ipc.js';

/** 6.1: the supervisor/worker pipe protocol, in unit tests and against the real bundled worker under Node. */
describe('worker frame codec and RPC', () => {
  it('reassembles frames split across chunks and rejects oversized, malformed and wrong-version frames', () => {
    const f = encodeFrame({ v: 1, gen: 1, kind: 'evt', event: 'ready' });
    const r = new FrameReader();
    expect(r.push(f.subarray(0, 3))).toEqual([]);
    expect(r.push(f.subarray(3))).toEqual([{ v: 1, gen: 1, kind: 'evt', event: 'ready' }]);
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, MAX_FRAME + 1);
    expect(() => new FrameReader().push(big)).toThrow(ProtocolError);
    const bad = new Uint8Array([0, 0, 0, 3, 0x7b, 0x7b, 0x7b]);
    expect(() => new FrameReader().push(bad)).toThrow(/UTF-8 JSON/);
    expect(() => validateMessage({ v: 2, gen: 1, kind: 'evt', event: 'x' })).toThrow(/version/);
    expect(() => validateMessage({ v: 1, gen: 1, kind: 'req', id: 1 })).toThrow(/bad request/);
    expect(() => validateMessage({ v: 1, gen: -1, kind: 'evt', event: 'x' })).toThrow(/generation/);
  });

  it('pairs requests with responses, refuses unknown methods, cancels, and ignores another generation', async () => {
    let a!: RpcEndpoint, b!: RpcEndpoint;
    a = new RpcEndpoint({ gen: 3, write: (f) => queueMicrotask(() => b.receive(f)) });
    b = new RpcEndpoint({ gen: 3, write: (f) => queueMicrotask(() => a.receive(f)) });
    b.handle('add', (p) => (p as number[]).reduce((x, y) => x + y, 0));
    let aborted = false;
    b.handle('slow', (_p, signal) => new Promise((res) => { signal.addEventListener('abort', () => { aborted = true; res(null); }); }));
    expect(await a.request('add', [1, 2, 3])).toBe(6);
    await expect(a.request('nope')).rejects.toThrow('unknown method');
    const ctl = new AbortController();
    const slow = a.request('slow', null, ctl.signal);
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    await expect(slow).rejects.toThrow('cancelled');
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
    // A frame of an older worker generation is dropped, never dispatched.
    b.receive(encodeFrame({ v: 1, gen: 2, kind: 'req', id: 99, method: 'add', params: [1] }));
    expect(b.rejected.at(-1)?.code).toBe('generation');
    a.close();
    await expect(a.request('add', [1])).rejects.toThrow('closed');
  });
});

describe('the bundled worker under Node (6.1)', () => {
  let bundle = '';
  beforeAll(async () => {
    // @ts-expect-error: plain ESM build script without type declarations
    const { buildWorker } = await import('../../../apps/desktop/worker-build.mjs');
    bundle = await buildWorker(join(mkdtempSync(join(tmpdir(), 'hivetex-worker-')), 'worker.mjs'));
  }, 60_000);
  const procs: ChildProcessWithoutNullStreams[] = [];
  afterAll(() => { for (const p of procs) p.kill(); });

  function start(gen = 5) {
    // An environment like the supervisor's: injection variables cleared, generation given.
    const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? '', HIVETEX_WORKER_GEN: String(gen), HIVETEX_WORKER_TEST: '1' }, stdio: 'pipe' });
    procs.push(child);
    const events: Array<{ event: string; data: unknown }> = [];
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const rpc = new RpcEndpoint({ gen, write: (f) => child.stdin.write(f) });
    rpc.on('ready', (d) => events.push({ event: 'ready', data: d }));
    child.stdout.on('data', (c: Buffer) => rpc.receive(new Uint8Array(c)));
    return { child, rpc, events, exited };
  }

  it('starts without a DOM, answers hello, cancels a slow call, and exits when its stdin closes', async () => {
    const w = start(5);
    expect(await w.rpc.request('hello')).toMatchObject({ protocol: 1, gen: 5, node: process.version });
    await expect.poll(() => w.events.length).toBe(1);
    const ctl = new AbortController();
    const slow = w.rpc.request('test.sleep', 5000, ctl.signal);
    ctl.abort();
    await expect(slow).rejects.toThrow('cancelled');
    expect(await w.rpc.request('ping', 'x')).toMatchObject({ pong: 'x' });
    await expect(w.rpc.request('fs.read', '/etc/passwd')).rejects.toThrow('unknown method');
    w.child.stdin.end(); // the supervisor went away
    expect(await w.exited).toBe(0);
  });

  it('drops frames of an obsolete generation and exits on malformed or oversized frames', async () => {
    const w = start(7);
    await w.rpc.request('hello');
    w.child.stdin.write(encodeFrame({ v: 1, gen: 6, kind: 'req', id: 1, method: 'shutdown' }));
    expect(await w.rpc.request('ping')).toBeTruthy(); // still alive: the old-generation shutdown was ignored
    w.child.stdin.write(new Uint8Array([0, 0, 0, 2, 0x5b, 0x5b]));
    expect(await w.exited).toBe(66);
    const w2 = start(8);
    await w2.rpc.request('hello');
    const huge = new Uint8Array(4);
    new DataView(huge.buffer).setUint32(0, MAX_FRAME + 10);
    w2.child.stdin.write(huge);
    expect(await w2.exited).toBe(66);
  });
});

describe('documented protocol and diagnostics (6.5)', () => {
  it('every JSON example in docs/worker-protocol.md is a valid message', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../../../docs/worker-protocol.md', import.meta.url), 'utf8');
    const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] as string));
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const e of examples) expect(() => validateMessage(e)).not.toThrow();
  });

  it('removes tokens, bearer values, keys, ciphertext and topics from log lines', async () => {
    const { redactDiagnostics } = await import('../src/worker-ipc.js');
    const ticket = 'eyJhbGciOiJFZERTQSJ9.eyJwaWQiOiJwcm9qZWN0LTEifQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const line = `ticket ${ticket} auth Bearer s3cr3t-session key ${'A'.repeat(44)} sha ${'a1'.repeat(32)} topic htabcdefghijklmnopqrstuvwxyz failed`;
    const out = redactDiagnostics(line);
    for (const secret of [ticket, 's3cr3t-session', 'A'.repeat(44), 'a1'.repeat(32), 'htabcdefghijklmnopqrstuvwxyz']) expect(out).not.toContain(secret);
    expect(out).toContain('failed');
    expect(redactDiagnostics('protocol error malformed')).toBe('protocol error malformed');
  });
});
