/** Local acceptance fixture (13.7): two real signaling/relay instances share the local Redis stack.
 * Fresh sockets alternate instances, every 31st payload is lost, and actual sockets rotate after 300 seconds.
 * Nothing is installed in the production server. No payloads, keys or identities are written to the report.
 * UPSTASH_REDIS_REST_URL=http://localhost:18079 UPSTASH_REDIS_REST_TOKEN=dev-stack-token
 * PORT=3013 APP_ORIGIN=http://localhost:1423 E2E_NO_LIMITS=1 pnpm --filter @hivetex/server exec tsx scripts/relay-acceptance-server.ts
 */
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Redis } from '@upstash/redis';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { localDeps } from '../src/local.js';
import { createDevPush } from '../src/dev-push.js';
import { createApplicationRelayRouter } from '../src/signal/application-relay.js';
import { createRedisRelayAdmission } from '../src/signal/relay-budget.js';
import { createSignalSession, createUpstashSignalBackend, UsageMeter, meterSignalBackend } from '../src/signal/hub.js';

const port = Number(process.env.PORT ?? 3000);
const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) throw new Error('the local Redis REST and Pub/Sub stack is required');
const deps = await localDeps({ port, log: false });
const namespace = 'acceptance-' + randomBytes(8).toString('hex');
const redis = new Redis({ url, token });
const meters = [new UsageMeter(), new UsageMeter()];
const stats = { connections: [0, 0], rotations: 0, forcedRotations: 0, droppedPayloads: 0, socketLifetimesMs: [] as number[] };
const sockets = new Set<WebSocket>();
let payloads = 0, connections = 0;
const instances = await Promise.all(meters.map(async (meter) => {
  const real = meterSignalBackend(await createUpstashSignalBackend(url, token), meter);
  const backend = { ...real, publish: async (channel: string, message: string) => {
    if (channel.startsWith('app-relay:')) {
      const envelope = JSON.parse(message) as { env?: string };
      if (envelope.env?.startsWith('F') && ++payloads % 31 === 0) { stats.droppedPayloads++; return; }
    }
    await real.publish(channel, message);
  } };
  return { ...deps, signal: backend, usage: meter, applicationRelay: createApplicationRelayRouter({
    namespace, backend, admission: createRedisRelayAdmission(redis, namespace), deps, meter,
  }) };
}));
const app = buildApp(deps);
app.get('/__dev/acceptance', (c) => c.json({ ...stats, instances: meters.map((m) => m.snapshot()) }));
app.post('/__dev/rotate', (c) => {
  for (const ws of sockets) { stats.forcedRotations++; ws.close(1001, 'forced acceptance rotation'); }
  return c.json({ ok: true });
});
const push = createDevPush().app;
const server = serve({ port, fetch: (req) => {
  const target = new URL(req.url);
  if (process.env.REQUEST_LOG) appendFileSync(process.env.REQUEST_LOG, JSON.stringify({ t: Date.now(), m: req.method, path: target.pathname, ua: req.headers.get('user-agent'), origin: req.headers.get('origin') }) + '\n');
  if (!target.pathname.startsWith('/__dev/push/')) return app.fetch(req);
  target.pathname = target.pathname.slice('/__dev/push'.length);
  return push.fetch(new Request(target, req));
} });
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/signal')) return void socket.destroy();
  const instance = connections++ % 2;
  stats.connections[instance] = (stats.connections[instance] ?? 0) + 1;
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    const started = Date.now();
    const session = createSignalSession({ get bufferedAmount() { return ws.bufferedAmount; }, send: (s) => ws.send(s), close: (code, reason) => ws.close(code, reason) }, instances[instance]!, instances[instance]!.signal);
    const timer = setTimeout(() => { stats.rotations++; ws.close(1001, '300-second hosting duration'); }, 300_000);
    ws.on('message', (data) => void session.onMessage(String(data)));
    ws.on('close', () => { sockets.delete(ws); clearTimeout(timer); stats.socketLifetimesMs.push(Date.now() - started); void session.onClose(); });
  });
});
console.log(`relay acceptance API: http://localhost:${port}; two Redis-backed instances, payload loss, actual 300 s rotation`);
