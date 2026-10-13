import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';

const WEB_ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:1420').origin;
const PDF = readFileSync(resolve(process.cwd(), 'e2e', 'sample.pdf')).toString('base64');
const TOKEN = 'a'.repeat(64);

/** Stand-in for the desktop app's local compile helper (apps/desktop/src-tauri/src/helper.rs). */
function helperDouble() {
  const seen: { paths: string[]; compiles: number; pairs: number; badOrigin: number } = { paths: [], compiles: 0, pairs: 0, badOrigin: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin ?? '';
    if (origin !== WEB_ORIGIN) {
      seen.badOrigin++;
      res.writeHead(403).end();
      return;
    }
    const cors = { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' }).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.paths.push(`${req.method} ${req.url}`);
      if (req.url === '/status') {
        res.writeHead(200, cors).end(JSON.stringify({ app: 'hivetex', version: 'test', compiler: 'texlive', supports: ['pdflatex', 'xelatex'], verifiedReads: true }));
      } else if (req.url === '/pair') {
        seen.pairs++;
        res.writeHead(200, cors).end(JSON.stringify({ token: TOKEN, id: 'p1' }));
      } else if (req.url === '/compile') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, cors).end(JSON.stringify({ error: 'not paired' }));
          return;
        }
        seen.compiles++;
        const files = (JSON.parse(body) as { files: { path: string }[] }).files.map((f) => f.path);
        res.writeHead(200, cors).end(JSON.stringify({ ok: true, log: `helper built ${files.join(',')}`, pdfB64: PDF, synctexB64: null, timedOut: false, localOnly: false }));
      } else res.writeHead(404, cors).end('{}');
    });
  });
  return { server, seen };
}

test('web: "Compile with my desktop app" pairs once, then builds go to the desktop app (4.2)', async ({ browser }) => {
  const { server, seen } = helperDouble();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const ctx = await browser.newContext();
    const u = await newUser(ctx, 'helper');
    const page = u.page;
    await page.evaluate((p) => localStorage.setItem('hivetex.helperPorts', String(p)), port);
    await createProject(page, uniq('helper-'));
    await addFile(page, 'main.tex');
    await page.getByRole('treeitem', { name: 'main.tex' }).click();
    await replaceEditorText(page, '\\documentclass{article}\n\\begin{document}\nHello helper\n\\end{document}\n');
    // not paired yet: the browser never contacts this computer by itself
    await expect(page.getByTestId('compiled-by')).toBeVisible();
    expect(seen.paths).toEqual([]);

    await page.getByTestId('use-desktop').click();
    await expect(page.getByTestId('compiler-state')).toContainText('desktop app (TeX Live)');
    await expect.poll(() => seen.compiles, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(seen.pairs).toBe(1);
    await expect(page.getByTestId('use-desktop')).toHaveCount(0);

    // later sessions use it directly (no new pairing)
    await page.reload();
    await expect(page.getByTestId('compiler-state')).toContainText('desktop app', { timeout: 30_000 });
    const before = seen.compiles;
    await page.getByRole('treeitem', { name: 'main.tex' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('% edit');
    await expect.poll(() => seen.compiles, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(seen.pairs).toBe(1);
    expect(seen.badOrigin).toBe(0);
    await ctx.close();
  } finally {
    server.close();
  }
});
