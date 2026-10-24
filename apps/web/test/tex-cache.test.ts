import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const first = 'https://app.test/texlive/tl2019-111111111111111111111111/';
const second = 'https://app.test/texlive/tl2019-222222222222222222222222/';
function serviceWorker(endpoint = second) {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (url: string) => store.get(url)?.clone(),
        put: async (url: string, response: Response) => { store.set(url, response.clone()); },
        delete: async (url: string) => store.delete(url),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  const handlers = new Map<string, (event: unknown) => void>();
  runInNewContext(script, {
    self: { location: new URL(`https://app.test/sw.js?tex=${encodeURIComponent(endpoint)}`), addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler), skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [] } },
    caches, fetch, crypto: webcrypto, Request, Response, URL, Date, Uint8Array,
  });
  async function dispatch(type: string, payload: Record<string, unknown>) {
    let pending: Promise<unknown> | undefined;
    handlers.get(type)!({ ...payload, respondWith: (p: Promise<unknown>) => { pending = p; }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    return await pending;
  }
  return { caches, stores, fetch, dispatch, request: async (url: string, method = 'GET') => await dispatch('fetch', { request: new Request(url, { method }) }) as Response };
}

it('a failed upgrade retains the old usable distribution and serves its open tabs without mixing caches', async () => {
  const sw = serviceWorker();
  const old = await sw.caches.open(`hivetex-tex-v2:${first}`);
  await old.put(`${first}manifest.json`, new Response('old compatible manifest'));
  await sw.dispatch('activate', {});
  sw.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
  expect((await sw.request(`${second}manifest.json`)).status).toBe(503);
  expect(await (await sw.request(`${first}manifest.json`)).text()).toBe('old compatible manifest');
  expect(sw.fetch).toHaveBeenCalledTimes(1);
  expect(await (await sw.caches.open(`hivetex-tex-v2:${second}`)).match(`${second}manifest.json`)).toBeUndefined();
});

it('rejects corrupt resource bytes, permits an explicit retry and serves verified bytes offline', async () => {
  const sw = serviceWorker();
  const hash = createHash('sha256').update('compatible resource').digest('hex');
  const url = `${second}files/${hash}`;
  sw.fetch.mockResolvedValueOnce(new Response('incompatible resource')).mockResolvedValueOnce(new Response('compatible resource'));
  expect((await sw.request(url)).status).toBe(502);
  expect(await (await sw.request(url)).text()).toBe('compatible resource');
  sw.fetch.mockRejectedValue(new Error('offline'));
  expect(await (await sw.request(url)).text()).toBe('compatible resource');
  expect(sw.fetch).toHaveBeenCalledTimes(2);
});

it('a readiness HEAD stores a full manifest, and maintenance only clears compiler resources', async () => {
  const sw = serviceWorker();
  const sources = await sw.caches.open('project-sources');
  await sources.put('project', new Response('my manuscript'));
  sw.fetch.mockResolvedValue(new Response('{"files":{}}'));
  expect(await (await sw.request(`${second}manifest.json`, 'HEAD')).text()).toBe('');
  sw.fetch.mockRejectedValue(new Error('offline'));
  expect(await (await sw.request(`${second}manifest.json`)).text()).toBe('{"files":{}}');
  await sw.dispatch('message', { data: { type: 'hivetex-tex-clear' } });
  expect(await sw.caches.keys()).toEqual(['project-sources']);
  expect(await (await sources.match('project'))?.text()).toBe('my manuscript');
});

it('resolves extensionless XeTeX fonts and BibTeX styles without confusing resource types', () => {
  const source = readFileSync(new URL('../../../scripts/tex-resource-adapter.js', import.meta.url), 'utf8');
  const self = { location: new URL(`${second}swiftlatexxetex.js`), hivetexResource: null as unknown as (key: string) => { id: string; url: string } | null };
  runInNewContext(source, { self, URL, console: { debug() {} }, hivetexFiles: { 'lmroman10-regular.otf': 'otf-hash', 'plain.bst': 'bst-hash', 'cmr10.tfm': 'tfm-hash', 'tex-text.tec': 'mapping-hash' } });
  expect(self.hivetexResource('47/lmroman10-regular')).toEqual({ id: 'otf-hash', url: `${second}files/otf-hash` });
  expect(self.hivetexResource('7/plain')?.id).toBe('bst-hash');
  expect(self.hivetexResource('3/cmr10')?.id).toBe('tfm-hash');
  expect(self.hivetexResource('39/tex-text')?.id).toBe('mapping-hash');
  expect(self.hivetexResource('47/otf-hash.otf')?.id).toBe('otf-hash');
  expect(self.hivetexResource('7/cmr10')).toBeNull();
  expect(self.hivetexResource('26/constructor')).toBeNull();
  expect(self.hivetexResource('26/../main.tex')).toBeNull();
});
