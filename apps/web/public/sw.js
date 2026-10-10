/* HiveTeX service worker: keeps the in-browser compiler's TeX files (formats, packages, fonts) on this device, so each
 * file is downloaded once. Only requests to the TeX file server given at registration (`?tex=<url>`) are touched.
 * Missing files are remembered for an hour, so a document probing for optional packages does not hit the server each
 * build. Chromium routes the compiler worker's requests through here; other browsers simply download as before. */
const CACHE = 'hivetex-tex-v1';
const MISSING_TTL_MS = 60 * 60 * 1000;
const TEX = new URL(self.location.href).searchParams.get('tex') || '';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('hivetex-tex-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

async function tell(file, state) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ type: 'hivetex-tex', file, state });
}

async function texFile(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) {
    const missingAt = Number(hit.headers.get('x-hivetex-missing') || 0);
    if (!missingAt) return hit;
    if (Date.now() - missingAt < MISSING_TTL_MS) return new Response(null, { status: 404 });
    await cache.delete(request.url);
  }
  const file = new URL(request.url).pathname.split('/').pop() || '';
  void tell(file, 'start');
  let res;
  try {
    res = await fetch(request);
  } catch (e) {
    void tell(file, 'failed');
    throw e;
  }
  if (res.status === 200 && !res.redirected && res.type !== 'opaque') {
    await cache.put(request.url, res.clone());
    void tell(file, 'done');
    return res;
  }
  if (res.status === 404) {
    // remember a missing file for a while
    await cache.put(request.url, new Response(null, { status: 200, headers: { 'x-hivetex-missing': String(Date.now()) } }));
  }
  void tell(file, 'failed');
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!TEX || req.method !== 'GET' || !req.url.startsWith(TEX)) return;
  event.respondWith(texFile(req));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'hivetex-tex-clear') event.waitUntil(caches.delete(CACHE));
});
