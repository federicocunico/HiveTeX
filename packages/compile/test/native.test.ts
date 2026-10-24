import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeSkip, nativeTestBinary } from '../../../scripts/native-test-bin.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeEngine } from '../src/index.js';
import { compileTemplate, pdfText } from '../../../e2e/fixtures/compile-templates.js';

const SUITE = 'native TeX engine over the Rust bridge (packages/compile/test/native.test.ts)';
const bin = nativeTestBinary('tex_cli', SUITE);

let child: ChildProcessWithoutNullStreams | null = null;
const pending: Array<(v: unknown) => void> = [];
let buf = '';

function start() {
  child = spawn(bin as string, [mkdtempSync(join(tmpdir(), 'p2p-native-'))], { windowsHide: true });
  child.stdout.on('data', (d) => {
    buf += String(d);
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      pending.shift()?.(JSON.parse(line));
      i = buf.indexOf('\n');
    }
  });
}

const invoke = <T>(cmd: string, args?: Record<string, unknown>) =>
  new Promise<T>((resolve) => {
    pending.push(resolve as (v: unknown) => void);
    child?.stdin.write(`${JSON.stringify({ cmd, args })}\n`);
  });

afterAll(() => child?.kill());

describe.skipIf(!bin)('native engine over the Rust bridge (8.6)', () => {
  for (const name of ['article', 'report'] as const) {
    it(`compiles the shipped ${name} with resolved bibliography, references and an image`, async () => {
      if (!child) start();
      const engine = new NativeEngine(invoke, `template-${name}`);
      expect(await engine.init(), 'Real native compiler required for template acceptance').toBe(true);
      const input = compileTemplate(name);
      for (const cache of ['cold', 'warm'] as const) {
        const result = await engine.compile(input, { timeoutMs: 120_000 });
        console.info(`${name}/${cache}: ${engine.flavor}; ${result.log.split('\n').find((line) => line.includes('Version')) ?? result.log.slice(0, 160)}`);
        expect(result.ok, result.log).toBe(true);
        const text = await pdfText(result.pdf!);
        expect(text).toContain(name === 'article' ? 'Your Paper Title' : 'Thesis Title');
        expect(text).toContain(name === 'article' ? 'Knuth' : 'Lamport');
        expect(text).not.toContain('?');
        expect(result.synctex?.length).toBeGreaterThan(0);
      }
    }, 300_000);
  }
  it('compiles the same templates through the paired HTTP desktop helper', async () => {
    if (!child) start();
    const { port } = await invoke<{ port: number }>('helper_start');
    const url = `http://127.0.0.1:${port}`;
    const headers = { Origin: 'http://localhost:1420', 'Content-Type': 'application/json' };
    const pair = await fetch(`${url}/pair`, { method: 'POST', headers, body: JSON.stringify({ username: 'acceptance', server: 'local-test' }) });
    expect(pair.ok).toBe(true);
    const { token } = await pair.json() as { token: string };
    for (const name of ['article', 'report'] as const) {
      const input = compileTemplate(name);
      const body = JSON.stringify({ project: `helper-${name}`, main: input.main, engine: input.engine, files: input.files.map((f) => ({ path: f.path, b64: Buffer.from(f.kind === 'text' ? f.text : f.bytes).toString('base64') })) });
      for (const cache of ['cold', 'warm']) {
        const response = await fetch(`${url}/compile`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(150_000) });
        expect(response.ok).toBe(true);
        const result = await response.json() as { ok: boolean; pdfB64: string; log: string };
        console.info(`helper ${name}/${cache}: ${result.log.split('\n').find((line) => line.includes('Version')) ?? ''}`);
        expect(result.ok, result.log).toBe(true);
        const text = await pdfText(new Uint8Array(Buffer.from(result.pdfB64, 'base64')));
        expect(text).toContain(name === 'article' ? 'Knuth' : 'Lamport');
        expect(text).not.toContain('?');
      }
    }
  }, 600_000);
  it('detects, compiles incrementally, and surfaces errors with the same contract as Tauri IPC', async (ctx) => {
    if (!child) start();
    const eng = new NativeEngine(invoke, 'proj-native-1');
    if (!(await eng.init())) {
      if (process.env.HIVETEX_NATIVE_TESTS === '1') throw new Error('Required native TeX compiler is unavailable');
      return nativeSkip(SUITE, 'no TeX compiler on this machine', 'install TeX Live, MiKTeX or TinyTeX', ctx);
    }
    expect(eng.supports).toContain('pdflatex');

    const doc = (body: string) => ({
      files: [
        { path: 'main.tex', kind: 'text' as const, text: `\\documentclass{article}\\begin{document}${body}\\end{document}\n` },
        { path: 'img/pixel.png', kind: 'binary' as const, bytes: new Uint8Array([137, 80, 78, 71]) },
      ],
      main: 'main.tex',
      engine: 'pdflatex' as const,
      stateHash: 'h',
    });
    const first = await eng.compile(doc('First'), { timeoutMs: 120_000 });
    expect(first.ok).toBe(true);
    expect(new TextDecoder().decode(first.pdf?.subarray(0, 4))).toBe('%PDF');
    expect(first.synctex?.length).toBeGreaterThan(10);

    // Second run sends only changed files (the binary is skipped) and still works.
    const second = await eng.compile(doc('Second edit'), { timeoutMs: 120_000 });
    expect(second.ok).toBe(true);

    const bad = await eng.compile(
      { ...doc(''), files: [{ path: 'main.tex', kind: 'text', text: '\\documentclass{article}\\begin{document}\\oops\\end{document}' }] },
      { timeoutMs: 120_000 },
    );
    expect(bad.ok).toBe(false);
    expect(bad.log).toContain('Undefined control sequence');
  }, 240_000);

  it('recovers when the Rust side lost its working directory (asks for content again)', async (ctx) => {
    const eng = new NativeEngine(invoke, 'proj-native-2');
    if (!(await eng.init())) {
      if (process.env.HIVETEX_NATIVE_TESTS === '1') throw new Error('Required native TeX compiler is unavailable');
      return nativeSkip(SUITE, 'no TeX compiler on this machine', 'install TeX Live, MiKTeX or TinyTeX', ctx);
    }
    const input = { files: [{ path: 'main.tex', kind: 'text' as const, text: '\\documentclass{article}\\begin{document}x\\end{document}' }], main: 'main.tex', engine: 'pdflatex' as const, stateHash: 'h' };
    expect((await eng.compile(input, { timeoutMs: 120_000 })).ok).toBe(true);
    // Simulate a fresh app data dir: use a new engine instance that believes files were already sent.
    const stale = new NativeEngine(invoke, 'proj-native-3');
    (stale as unknown as { sent: Map<string, string> }).sent.set('main.tex', 'deadbeef');
    expect((await stale.compile(input, { timeoutMs: 120_000 })).ok).toBe(true);
  }, 240_000);
});
