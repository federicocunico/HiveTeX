import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

test('web: the in-browser compiler downloads each TeX file once; missing files are remembered (5.1)', async ({ page }) => {
  // stand-in TeX file server
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url?.endsWith('/present.sty')) res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' }).end('\\ProvidesPackage{present}');
    else res.writeHead(404, cors).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const tex = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    await page.goto('/#/login');
    await page.evaluate(async (t) => {
      await navigator.serviceWorker.register(`/sw.js?tex=${encodeURIComponent(t)}`);
      await navigator.serviceWorker.ready;
    }, tex);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    // the compiler runs in a worker and loads files with synchronous XHR, like SwiftLaTeX's kpathsea
    const load = (files: string[]) =>
      page.evaluate(
        ([t, fs]) =>
          new Promise<number[]>((resolve) => {
            const src = `onmessage = (e) => { const out = e.data.files.map((f) => { const x = new XMLHttpRequest(); x.open('GET', e.data.tex + f, false); x.send(); return x.status; }); postMessage(out); };`;
            const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            w.onmessage = (e) => resolve(e.data as number[]);
            w.postMessage({ tex: t, files: fs });
          }),
        [tex, files] as const,
      );
    const files = ['pdftex/26/present.sty', 'pdftex/26/absent.sty'];
    expect(await load(files)).toEqual([200, 404]);
    expect(hits).toEqual(['/pdftex/26/present.sty', '/pdftex/26/absent.sty']);
    // second build: nothing goes to the server
    expect(await load(files)).toEqual([200, 404]);
    expect(hits).toHaveLength(2);
  } finally {
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      await caches.delete('hivetex-tex-v1');
    });
    server.close();
  }
});
