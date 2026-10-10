import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeEngine } from '../src/index.js';

const exe = fileURLToPath(new URL('../../../apps/desktop/src-tauri/target/debug/examples/tex_cli.exe', import.meta.url));
const exeUnix = exe.replace(/\.exe$/, '');
const bin = existsSync(exe) ? exe : existsSync(exeUnix) ? exeUnix : null;

let child: ChildProcessWithoutNullStreams | null = null;
const pending: Array<(v: unknown) => void> = [];
let buf = '';

function start() {
  child = spawn(bin as string, [mkdtempSync(join(tmpdir(), 'p2p-native-'))]);
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
  it('detects, compiles incrementally, and surfaces errors with the same contract as Tauri IPC', async () => {
    start();
    const eng = new NativeEngine(invoke, 'proj-native-1');
    if (!(await eng.init())) return; // no TeX on this machine
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

  it('recovers when the Rust side lost its working directory (asks for content again)', async () => {
    const eng = new NativeEngine(invoke, 'proj-native-2');
    if (!(await eng.init())) return;
    const input = { files: [{ path: 'main.tex', kind: 'text' as const, text: '\\documentclass{article}\\begin{document}x\\end{document}' }], main: 'main.tex', engine: 'pdflatex' as const, stateHash: 'h' };
    expect((await eng.compile(input, { timeoutMs: 120_000 })).ok).toBe(true);
    // Simulate a fresh app data dir: use a new engine instance that believes files were already sent.
    const stale = new NativeEngine(invoke, 'proj-native-3');
    (stale as unknown as { sent: Map<string, string> }).sent.set('main.tex', 'deadbeef');
    expect((await stale.compile(input, { timeoutMs: 120_000 })).ok).toBe(true);
  }, 240_000);
});
