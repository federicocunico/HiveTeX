import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { test } from './trace-fixture.js';
import { appExe, ensureNoTestInstance, identifier, quitThroughPage, stopApp } from '../apps/desktop/e2e/harness.mjs';
import { addFile, PW, uniq } from './helpers.js';
import { articleProject } from './real-workspace.js';
import { aligned, geometry as measure, scrollToLine, type EditorHost } from './editor-geometry.js';
import { manuscript } from './fixtures/manuscript.js';
import { pdfText } from './fixtures/compile-templates.js';
import { nativeWebview } from './native-webview.mjs';

test('Windows WebView2 authoring: real local automatic PDF and long CRLF editor', async ({}, info) => {
  test.skip(process.env.HIVETEX_DESKTOP_AUTHORING !== '1', 'Missing native acceptance: opt in after building the isolated desktop harness');
  expect(process.platform, 'This CDP harness verifies Windows WebView2; macOS/Linux require their native runners').toBe('win32');
  test.setTimeout(240_000);
  await ensureNoTestInstance();
  const port = 9451;
  const debug = await nativeWebview(appExe, port);
  const child = spawn(debug.exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, ...debug.env,
    HIVETEX_TEST_LIFECYCLE_REPORT: info.outputPath('native-lifecycle-current.json'),
  } });
  let launchLog = '';
  child.stdout.on('data', (data) => { launchLog += String(data); });
  child.stderr.on('data', (data) => { launchLog += String(data); });
  child.on('error', (error) => { launchLog += String(error); });
  const lifecycle: unknown[] = [];
  const recordLifecycle = async (stage: string) => {
    let state: any;
    await expect.poll(async () => {
      try { state = JSON.parse(await readFile(info.outputPath('native-lifecycle-current.json'), 'utf8')); return state.pid === child.pid && state.visibleWindows === 1; }
      catch { return false; }
    }).toBe(true);
    expect(state.identifier).toBe(identifier); expect(state.trayCount).toBe(1); expect(state.windows).toEqual(['main']);
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
    expect(query.status).toBe(0);
    const parsed = JSON.parse(query.stdout || '[]'), children = Array.isArray(parsed) ? parsed : [parsed];
    expect(children.filter((p: any) => p.Name === 'node.exe')).toHaveLength(1);
    lifecycle.push({ stage, ...state, children });
  };
  let cdp: Browser | undefined, page: Page | undefined;
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false), { timeout: 30_000 }).toBe(true);
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await expect.poll(() => cdp!.contexts().flatMap((c) => c.pages()).length).toBeGreaterThan(0);
    page = cdp.contexts().flatMap((c) => c.pages())[0]!;
    const p = page;
    await p.waitForFunction(() => !!(window as any).__TAURI_INTERNALS__ && !!document.getElementById('app'));
    await p.evaluate(() => {
      localStorage.removeItem('hivetex.fakeEngine'); localStorage.setItem('hivetex.test', '1');
      localStorage.removeItem('hivetex.layout');
      localStorage.setItem('hivetex.prefs', JSON.stringify({ compileSchedule: 'manual', editorFontSize: 14 }));
    });
    await p.reload();
    if (await p.getByRole('button', { name: 'Account menu' }).isVisible()) {
      await p.getByRole('button', { name: 'Account menu' }).click();
      await p.getByRole('menuitem', { name: 'Sign out' }).click();
    }
    const username = uniq('nativeauthor');
    await p.evaluate(() => { location.hash = '/register'; });
    await p.getByLabel('Username').fill(username); await p.getByLabel('Email').fill(`${username}@example.com`);
    await p.locator('input[type=password]').nth(0).fill(PW); await p.locator('input[type=password]').nth(1).fill(PW);
    await p.getByRole('button', { name: 'Create account' }).click();
    await expect(p.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    await p.setViewportSize({ width: 1440, height: 900 });
    if (process.env.HIVETEX_DESKTOP_INSTALL === '1') {
      await recordLifecycle('before managed compiler setup');
      const installed = p.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('managed_install', { component: 'tinytex' }));
      // A second launch during real download/extraction must hand over without another owning app/worker.
      const secondary = spawn(debug.exe, [], { windowsHide: true, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { secondary.kill(); reject(new Error('Secondary launch did not exit during compiler setup')); }, 15_000);
        secondary.once('error', (error) => { clearTimeout(timer); reject(error); });
        secondary.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Secondary exit ${code}`)); });
      });
      await recordLifecycle('managed compiler setup requested, secondary exited');
      expect((await installed).version).toBe('v2026.10');
      await recordLifecycle('managed compiler setup completed');
    }
    await articleProject(p, 'native-article-');
    await recordLifecycle('compiler detected, before manual build');
    await p.getByTestId('compile-btn').click();
    await recordLifecycle('manual build requested');
    try { await expect(p.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 120_000 }); }
    catch (error) {
      const state = await p.evaluate(async () => {
        const s = (window as any).__p2p.session, c = s.compiler;
        let stale; try { stale = await c.isStale(); } catch (e) { stale = String(e); }
        return { stale, sourceSeq: s.sourceSeq, pdfSourceSeq: s.pdfSourceSeq, modelSeq: s.model.changeSeq,
          accepted: s.acceptedPdf?.source, engineRevision: c.engineRevision, builtRevision: c.builtRevision,
          missing: s.model.missingText(), root: s.model.availability('root'), files: s.model.list() };
      });
      console.error('Native build identity', JSON.stringify(state));
      throw error;
    }
    const result = () => p.evaluate(() => {
      const s = (window as any).__p2p.session;
      return { pdf: Array.from(s.pdf as Uint8Array), log: s.result.log, rev: s.pdfRev, engine: s.engineKind, fake: localStorage.getItem('hivetex.fakeEngine') };
    });
    const first = await result();
    expect(first.engine).toBe('native'); expect(first.fake).toBeNull();
    expect(await pdfText(new Uint8Array(first.pdf))).toContain('Knuth');
    await p.getByRole('button', { name: 'Compile options', exact: true }).click();
    await p.getByRole('menuitem', { name: /^After changes/ }).click();
    await p.evaluate(() => {
      const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
      const at = view.state.doc.toString().indexOf('\\end{document}');
      view.dispatch({ changes: { from: at, insert: '\nNative automatic build marker.\n' } });
    });
    await expect.poll(async () => (await result()).rev, { timeout: 120_000 }).toBeGreaterThan(first.rev);
    const automatic = await result();
    await recordLifecycle('automatic build completed');
    expect(await pdfText(new Uint8Array(automatic.pdf))).toContain('Native automatic build marker');
    await expect(p.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
    await p.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(p.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
    await p.getByRole('button', { name: 'Compile options', exact: true }).click();
    await p.getByRole('menuitem', { name: /^Manual/ }).click();
    if (await p.getByRole('button', { name: 'Collapse problems' }).isVisible()) await p.getByRole('button', { name: 'Collapse problems' }).click();
    await addFile(p, 'long-manuscript.tex');
    await p.getByRole('treeitem', { name: 'long-manuscript.tex' }).click();
    await p.evaluate((text) => {
      const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }, manuscript('\r\n'));
    await p.evaluate(() => document.fonts.ready.then(() => undefined));
    const geometry = [];
    for (const editorFontSize of [11, 14, 18, 24]) {
      await p.evaluate((editorFontSize) => {
        const newValue = JSON.stringify({ ...JSON.parse(localStorage.getItem('hivetex.prefs') ?? '{}'), editorFontSize });
        localStorage.setItem('hivetex.prefs', newValue);
        dispatchEvent(new StorageEvent('storage', { key: 'hivetex.prefs', newValue }));
      }, editorFontSize);
      await expect.poll(() => p.locator('.cm-content').evaluate((el) => getComputedStyle(el).fontSize)).toBe(`${editorFontSize}px`);
      for (const width of [1440, 1180]) {
        await p.setViewportSize({ width, height: 900 });
        for (const line of [1, 1900, 6100]) {
          await scrollToLine(p, line);
          try { geometry.push({ editorFontSize, width, line, ...await aligned(p) }); }
          catch (error) {
            await info.attach('native-geometry-failure.json', { body: JSON.stringify({ editorFontSize, width, line, measurement: await p.evaluate(measure) }), contentType: 'application/json' });
            await p.screenshot({ path: info.outputPath('native-geometry-failure.png') });
            throw error;
          }
        }
      }
    }
    await p.screenshot({ path: info.outputPath('native-authoring.png') });
    const evidence = JSON.stringify({ identifier, exe: appExe, pid: child.pid, webview: cdp.version(), engine: automatic.engine, lifecycle, geometry, missingAcceptance: ['macOS WKWebView', 'Linux WebKitGTK'] }, null, 2);
    await writeFile(info.outputPath('native-authoring.json'), evidence);
    await writeFile(info.outputPath('native-compiler.log'), automatic.log);
    await info.attach('native-authoring.json', { body: evidence, contentType: 'application/json' });
    await info.attach('native-compiler.log', { body: automatic.log, contentType: 'text/plain' });
  } finally {
    const processes = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
    const launch = JSON.stringify({ exe: debug.exe, env: debug.env, exitCode: child.exitCode, log: launchLog, children: processes.stdout });
    await writeFile(info.outputPath('native-launch.json'), launch);
    await info.attach('native-launch.json', { body: launch, contentType: 'application/json' });
    try {
      const stopped = await stopApp(child.pid, page ? () => quitThroughPage(page!) : undefined);
      console.info(`Native authoring app cleanup: ${stopped}`);
      await cdp?.close().catch(() => {});
    } finally { await debug.dispose(); }
  }
});
