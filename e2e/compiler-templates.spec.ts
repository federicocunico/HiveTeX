import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test } from './trace-fixture.js';
import { compileTemplate, pdfText } from './fixtures/compile-templates.js';

for (const name of ['article', 'report'] as const) for (const compiler of ['pdflatex', 'xelatex'] as const) {
  test(`bundled ${compiler} resolves ${name} on cold, warm and offline reopen`, async ({ page, context }, info) => {
    test.setTimeout(240_000);
      const messages: string[] = [];
      page.on('console', message => messages.push(message.text()));
      await page.goto('/#/login');
      await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
      const template = compileTemplate(name);
      const input = { ...template, engine: compiler, files: template.files.map((f) => f.kind === 'binary' ? { ...f, bytes: Array.from(f.bytes) } : f) };
      const run = () => page.evaluate(async ({ input }) => {
        localStorage.removeItem('hivetex.fakeEngine');
        localStorage.removeItem('texliveUrl');
        sessionStorage.removeItem('hivetex.texserver');
        const path = '/src/lib/wasm-engine.ts';
        const { loadWasmEngine, texliveEndpoint } = await import(/* @vite-ignore */ path);
        const engine = await loadWasmEngine('template-acceptance');
        if (!engine) throw new Error('Real WASM engine unavailable');
        try {
          const out = await engine.compile({ ...input, files: input.files.map((f) => f.kind === 'binary' ? { ...f, bytes: new Uint8Array(f.bytes) } : f) }, { timeoutMs: 150_000 });
          return { ok: out.ok, log: out.log, endpoint: texliveEndpoint(), pdf: out.pdf ? Array.from(out.pdf as Uint8Array) : [] };
        } finally { engine.dispose(); }
      }, { input });
      // An incompatible legacy cache must survive the upgrade, but never supply the new compiler.
      await page.evaluate(async () => {
        const old = await caches.open('hivetex-tex-v1');
        await old.put('/legacy-format-marker', new Response('incompatible legacy format'));
      });
      for (const stage of ['cold', 'warm', 'offline-reopen']) {
        if (stage === 'offline-reopen') {
          // The application/API remain available; every compiler resource is now network-inaccessible.
          // This also catches accidental fallback to a public TeX package server.
          await context.route('**/*', route => /\/texlive\/|\/swiftlatex\/|texlive2\.swiftlatex\.com/.test(route.request().url()) ? route.abort('internetdisconnected') : route.continue());
          await page.reload();
          await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
        }
        const result = await run();
        expect(result.endpoint).toMatch(/\/texlive\/tl2019-[a-f0-9]+\/$/);
        const logPath = info.outputPath(`${stage}-compiler.log`);
        await writeFile(logPath, result.log);
        await info.attach(`${stage}-compiler.log`, { path: logPath, contentType: 'text/plain' });
        if (!result.ok) await info.attach('resource-console.txt', { body: messages.join('\n'), contentType: 'text/plain' });
        expect(result.ok, `${stage}: ${result.log}`).toBe(true);
        const text = await pdfText(new Uint8Array(result.pdf));
        await info.attach(`${stage}-pdf-text.txt`, { body: text, contentType: 'text/plain' });
        expect(text).toContain(name === 'article' ? 'Your Paper Title' : 'Thesis Title');
        expect(text).toContain(name === 'article' ? 'Knuth' : 'Lamport');
        expect(text).not.toContain('?');
        expect(result.log).not.toMatch(/undefined references|Citation .+ undefined/);
      }
      const cachesUsed = await page.evaluate(async () => ({ keys: await caches.keys(), legacy: await (await caches.open('hivetex-tex-v1')).match('/legacy-format-marker').then(r => r?.text()) }));
      expect(cachesUsed.legacy).toBe('incompatible legacy format');
      expect(cachesUsed.keys.some(key => /hivetex-tex-v2:.*\/texlive\/tl2019-/.test(key))).toBe(true);
      const cachePath = info.outputPath('cache-identity.json');
      await writeFile(cachePath, JSON.stringify(cachesUsed, null, 2));
      await info.attach('cache-identity.json', { path: cachePath, contentType: 'application/json' });
  });
}
