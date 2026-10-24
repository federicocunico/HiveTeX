import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { nativeTestBinary } from '../../../scripts/native-test-bin.mjs';
import { compileTemplate, pdfText } from '../../../e2e/fixtures/compile-templates.js';
import { NativeEngine } from '../src/index.js';

// Opt in with a disposable managed root. This suite changes only that distribution's repository/packages.
const root = process.env.HIVETEX_TINYTEX_ROOT;
it.skipIf(!root)('managed native/helper recover from package outage and build cached templates offline', async () => {
  const bin = nativeTestBinary('tex_cli', 'managed package acceptance');
  expect(bin, 'Build the required real bridge with HIVETEX_NATIVE_TESTS=1').toBeTruthy();
  const texbin = join(resolve(root!), 'tinytex', 'bin', process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'universal-darwin' : 'x86_64-linux');
  const tlmgr = join(texbin, process.platform === 'win32' ? 'tlmgr.bat' : 'tlmgr');
  const manage = (...args: string[]) => {
    const result = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$tlArgs = ConvertFrom-Json $env:HIVETEX_TEST_TLMGR_ARGS; & $env:HIVETEX_TEST_TLMGR @tlArgs; exit $LASTEXITCODE'], {
        encoding: 'utf8', windowsHide: true, timeout: 60_000,
        env: { ...process.env, HIVETEX_TEST_TLMGR: tlmgr, HIVETEX_TEST_TLMGR_ARGS: JSON.stringify(args) },
      })
      : spawnSync(tlmgr, args, { encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`tlmgr ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  const original = manage('option', 'repository').match(/\(repository\):\s*(.+)/)?.[1]?.trim();
  expect(original, 'Record repository before changing the disposable installation').toBeTruthy();
  let requests = 0;
  const outage = createServer((_req, res) => { requests++; res.writeHead(503); res.end('Acceptance package outage'); });
  await new Promise<void>((done) => outage.listen(0, '127.0.0.1', done));
  const address = outage.address() as { port: number };
  const offline = `http://127.0.0.1:${address.port}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    manage('remove', '--force', 'tikz-cd', 'lipsum');
    child = spawn(bin!, [mkdtempSync(join(tmpdir(), 'hivetex-managed-build-'))], {
      windowsHide: true, env: { ...process.env, HIVETEX_IGNORE_SYSTEM_TEX: '1' },
    });
    const pending: Array<(value: unknown) => void> = [];
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += String(data);
      for (let n; (n = buffer.indexOf('\n')) >= 0;) {
        pending.shift()?.(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1);
      }
    });
    const invoke = <T>(cmd: string, args?: Record<string, unknown>) => new Promise<T>((done) => {
      pending.push(done as (value: unknown) => void); child!.stdin.write(`${JSON.stringify({ cmd, args })}\n`);
    });
    const engine = new NativeEngine(invoke, 'managed-recovery');
    expect(await engine.init()).toBe(true); expect(engine.flavor).toContain('tinytex');
    // Reproduce the partially written filename index observed when tlmgr was killed during mktexlsr.
    const indexPath = join(resolve(root!), 'tinytex', 'texmf-dist', 'ls-R');
    const pendingPath = join(texbin, '.hivetex-package-pending');
    const savedIndex = readFileSync(indexPath);
    try {
      writeFileSync(pendingPath, 'Interrupted package operation');
      writeFileSync(indexPath, '% ls-R -- filename database for kpathsea; do not change this line.\n');
      const repaired = await engine.compile(compileTemplate('article'), { timeoutMs: 120_000 });
      expect(repaired.ok, repaired.log).toBe(true);
      expect(await pdfText(repaired.pdf!)).toContain('Knuth');
      expect(existsSync(pendingPath)).toBe(false);
    } finally {
      if (existsSync(pendingPath)) { writeFileSync(indexPath, savedIndex); rmSync(pendingPath); }
    }
    const { port } = await invoke<{ port: number }>('helper_start');
    const headers = { Origin: 'http://localhost:1420', 'Content-Type': 'application/json' };
    const pair = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers, body: JSON.stringify({ username: 'package-acceptance', server: 'isolated' }) });
    expect(pair.ok).toBe(true);
    const { token } = await pair.json() as { token: string };
    const helperCompile = async (input: ReturnType<typeof compileTemplate>) => {
      const response = await fetch(`http://127.0.0.1:${port}/compile`, {
        method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(330_000),
        body: JSON.stringify({ project: 'managed-recovery', main: input.main, engine: input.engine,
          files: input.files.map((f) => ({ path: f.path, b64: Buffer.from(f.kind === 'text' ? f.text : f.bytes).toString('base64') })) }),
      });
      expect(response.ok).toBe(true);
      const result = await response.json() as { ok: boolean; pdfB64: string; log: string };
      return { ...result, pdf: new Uint8Array(Buffer.from(result.pdfB64 ?? '', 'base64')) };
    };
    for (const mode of ['native', 'helper'] as const) {
      const pkg = mode === 'native' ? 'tikz-cd' : 'lipsum';
      const input = compileTemplate('article');
      const main = input.files.find((f) => f.path === input.main)!;
      if (main.kind !== 'text') throw new Error('Expected article source');
      main.text = main.text.replace('\\begin{document}', `\\usepackage{${pkg}}\n\\begin{document}`);
      // Cold package metadata/downloads may take minutes; both routes get the helper's five-minute budget.
      const compile = () => mode === 'native' ? engine.compile(input, { timeoutMs: 300_000 }) : helperCompile(input);
      manage('option', 'repository', offline);
      const failed = await compile();
      expect(failed.ok, `${mode}: missing package must fail during outage`).toBe(false);
      expect(failed.log).toContain(`${pkg}.sty`);
      expect(requests).toBeGreaterThan(0);
      manage('option', 'repository', original!);
      const retry = await compile();
      expect(retry.ok, retry.log).toBe(true);
      expect(await pdfText(retry.pdf!)).toContain('Knuth');
      manage('option', 'repository', offline);
      requests = 0;
      for (const name of ['article', 'report'] as const) {
        const template = compileTemplate(name);
        const result = mode === 'native' ? await engine.compile(template, { timeoutMs: 120_000 }) : await helperCompile(template);
        expect(result.ok, result.log).toBe(true);
        const text = await pdfText(result.pdf!);
        expect(text).toContain(name === 'article' ? 'Knuth' : 'Lamport'); expect(text).not.toContain('?');
      }
      const cached = await compile(); expect(cached.ok, cached.log).toBe(true);
      expect(requests, 'Cached native/helper builds must not need a package repository').toBe(0);
      console.info(`${mode}: package ${pkg} outage, explicit retry, cached article/report passed`);
    }
  } finally {
    if (child?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    }
    await new Promise<void>((done) => outage.close(() => done()));
    if (original) manage('option', 'repository', original);
  }
}, 600_000);
