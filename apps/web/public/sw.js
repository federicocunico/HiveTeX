/* HiveTeX service worker: keeps the in-browser compiler's TeX files (formats, packages, fonts) on this device, so each
 * file is downloaded once. Only requests to the TeX file server given at registration (`?tex=<url>`) are touched.
 * Missing files are remembered for an hour, so a document probing for optional packages does not hit the server each
 * build. Chromium routes the compiler worker's requests through here; other browsers simply download as before. */
const MISSING_TTL_MS = 60 * 60 * 1000;
const TEX = new URL(self.location.href).searchParams.get('tex') || '';
const CACHE = `hivetex-tex-v2:${TEX}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Retain older distributions until explicit cache maintenance: a failed upgrade must not destroy offline work.
      await self.clients.claim();
    })(),
  );
});

async function tell(file, state) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage({ type: 'hivetex-tex', file, state });
}

async function texFile(request, endpoint = TEX) {
  const cache = await caches.open(`hivetex-tex-v2:${endpoint}`);
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
    const hash = new URL(request.url).pathname.match(/\/texlive\/[^/]+\/files\/([a-f0-9]{64})$/)?.[1];
    if (hash) {
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (actual !== hash) { void tell(file, 'failed'); return new Response('Compiler resource checksum mismatch', { status: 502 }); }
    }
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
  const url = new URL(req.url);
  const bundledPath = url.origin === self.location.origin && url.pathname.match(/^(.*\/texlive\/tl2019-[a-f0-9]{24}\/)/)?.[1];
  // An older open tab keeps its own immutable distribution, even after a newer tab updates this worker.
  const endpoint = bundledPath ? `${url.origin}${bundledPath}` : TEX;
  if (!endpoint || !['GET', 'HEAD'].includes(req.method) || !req.url.startsWith(endpoint)) return;
  if (req.method === 'HEAD') {
    event.respondWith((async () => {
      const hit = await (await caches.open(`hivetex-tex-v2:${endpoint}`)).match(req.url);
      if (hit && !hit.headers.get('x-hivetex-missing')) return new Response(null, { status: hit.status, headers: hit.headers });
      // Cache the complete manifest when checking readiness, never a bodyless HEAD response.
      const response = await texFile(new Request(req.url), endpoint);
      return new Response(null, { status: response.status, headers: response.headers });
    })());
    return;
  }
  event.respondWith(texFile(req, endpoint));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'hivetex-tex-clear') event.waitUntil(caches.delete(CACHE));
});
