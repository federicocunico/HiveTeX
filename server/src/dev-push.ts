import { Hono } from 'hono';

/**
 * A minimal ntfy-compatible push service for the local dev server and its end-to-end tests, so doorbell rings never
 * leave the machine during development: `POST /<topic>` publishes the body, `GET /<topic>[,<topic>…]/json` streams
 * newline-delimited JSON events (`open`, `keepalive`, `message`) like ntfy. No caching: a ring reaches only current
 * subscribers, as with `Cache: no` on ntfy.sh. Not used by deployments.
 */
export function createDevPush(keepaliveMs = 25_000) {
  const subs = new Map<string, Set<(line: string) => void>>();
  let seq = 0;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', '*');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });
  app.post('/:topic', async (c) => {
    const topic = c.req.param('topic');
    const message = (await c.req.text()).slice(0, 4096);
    const event = { id: String(++seq), time: Math.floor(Date.now() / 1000), event: 'message', topic, message };
    for (const send of subs.get(topic) ?? []) send(`${JSON.stringify(event)}\n`);
    return c.json(event);
  });
  app.get('/:topics/json', (c) => {
    const topics = c.req.param('topics').split(',').filter(Boolean).slice(0, 64);
    let send: (line: string) => void = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        send = (line) => {
          try {
            controller.enqueue(enc.encode(line));
          } catch {
            /* closed */
          }
        };
        for (const t of topics) {
          const s = subs.get(t) ?? new Set();
          s.add(send);
          subs.set(t, s);
        }
        send(`${JSON.stringify({ id: String(++seq), time: Math.floor(Date.now() / 1000), event: 'open', topic: topics.join(',') })}\n`);
        timer = setInterval(() => send(`${JSON.stringify({ event: 'keepalive', time: Math.floor(Date.now() / 1000) })}\n`), keepaliveMs);
      },
      cancel() {
        if (timer) clearInterval(timer);
        for (const t of topics) subs.get(t)?.delete(send);
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  });
  return { app, subscribers: (topic: string) => subs.get(topic)?.size ?? 0 };
}
