import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { AppError } from './errors.js';
import type { Deps, Env } from './deps.js';
import { csrfGuard, requestContext } from './middleware.js';
import { accountRoutes } from './accounts/routes.js';
import { deviceRoutes, keyRoutes, projectRoutes } from './projects/routes.js';
import { githubRoutes } from './github.js';
import { createSignalSession } from './signal/hub.js';
import { turnRoutes } from './signal/turn.js';

export function buildApp(deps: Deps) {
  const app = new Hono<Env>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', requestContext);
  // The desktop app (tauri://localhost, http(s)://tauri.localhost) and configured extra origins call the API
  // cross-origin with bearer tokens. No credentials: cookies stay same-origin for the web app. Other origins get no
  // CORS headers at all, so browsers keep blocking them.
  app.use(
    '*',
    cors({
      origin: (origin) => (deps.config.extraOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413),
    }),
  );
  app.use('*', csrfGuard);

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/auth', accountRoutes);
  app.route('/projects', projectRoutes);
  app.route('/devices', deviceRoutes);
  app.route('/keys', keyRoutes);
  app.route('/turn', turnRoutes);
  app.route('/github', githubRoutes);

  // Authentication happens in-band (first message carries the ticket), never in the URL.
  app.get('/signal', async (c) => {
    if (!deps.upgradeWebSocket || !deps.signal || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: { code: 'upgrade_required', message: 'WebSocket required' } }, 426);
    }
    const backend = deps.signal;
    return deps.upgradeWebSocket(c.req.raw, (sock) => createSignalSession(sock, deps, backend));
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      for (const [k, val] of Object.entries(err.headers ?? {})) c.header(k, val);
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    console.error('unhandled', c.get('requestId'), err instanceof Error ? err.message : 'unknown');
    return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });
  return app;
}

let cached: Hono<Env> | undefined;

/** Lazily wires production dependencies from the environment (Vercel Functions). */
export function createApp(): Hono<Env> {
  if (cached) return cached;
  const app = new Hono<Env>();
  app.all('*', async (c) => {
    if (!cached) {
      const { productionDeps } = await import('./production.js');
      cached = buildApp(await productionDeps());
    }
    return cached.fetch(c.req.raw);
  });
  return app;
}
