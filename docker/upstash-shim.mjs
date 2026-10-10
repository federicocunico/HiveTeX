// Upstash REST emulator front for the local stack. serverless-redis-http (SRH) covers ordinary commands but not
// Upstash's pub/sub streaming endpoint, which HiveTeX signaling uses (`redis.subscribe`). This shim implements
// `POST /subscribe/<channel>` (Server-Sent Events over a real Redis SUBSCRIBE) and forwards everything else to SRH.
// No dependencies: plain Node 22.
import { createServer } from 'node:http';
import { connect } from 'node:net';

const PORT = Number(process.env.PORT ?? 80);
const TOKEN = process.env.SRH_TOKEN ?? '';
const SRH = process.env.SRH_URL ?? 'http://srh:80';
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** Incremental RESP2 reader yielding top-level replies (arrays of Buffers/numbers). */
function respReader(onReply) {
  let buf = Buffer.alloc(0);
  const parse = (pos) => {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const type = String.fromCharCode(buf[pos]);
    const line = buf.subarray(pos + 1, eol).toString();
    const next = eol + 2;
    if (type === '+' || type === '-') return { value: line, end: next };
    if (type === ':') return { value: Number(line), end: next };
    if (type === '$') {
      const n = Number(line);
      if (n < 0) return { value: null, end: next };
      if (buf.length < next + n + 2) return null;
      return { value: buf.subarray(next, next + n), end: next + n + 2 };
    }
    if (type === '*') {
      const n = Number(line);
      const items = [];
      let p = next;
      for (let i = 0; i < n; i++) {
        const r = parse(p);
        if (!r) return null;
        items.push(r.value);
        p = r.end;
      }
      return { value: items, end: p };
    }
    throw new Error(`unexpected RESP type ${type}`);
  };
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const r = parse(0);
      if (!r) return;
      buf = buf.subarray(r.end);
      onReply(r.value);
    }
  };
}

const command = (...args) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

function subscribe(channels, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const sock = connect(REDIS_PORT, REDIS_HOST, () => sock.write(command('SUBSCRIBE', ...channels)));
  sock.on(
    'data',
    respReader((reply) => {
      if (!Array.isArray(reply)) return;
      const [kind, channel, payload] = reply.map((x) => (Buffer.isBuffer(x) ? x.toString() : String(x)));
      // Same line format as Upstash: data: <type>,<channel>,<payload>
      res.write(`data: ${kind},${channel},${String(payload).replace(/\n/g, '\\n')}\n\n`);
    }),
  );
  const close = () => {
    sock.destroy();
    res.end();
  };
  sock.on('error', close);
  sock.on('close', () => res.end());
  req.on('close', () => sock.destroy());
}

async function forward(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  const r = await fetch(SRH + req.url, {
    method: req.method,
    headers,
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
  res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => k !== 'content-encoding' && k !== 'transfer-encoding')));
  res.end(Buffer.from(await r.arrayBuffer()));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__health') return void res.end('ok');
  if (url.pathname.startsWith('/subscribe/')) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const channels = url.pathname.slice('/subscribe/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    return subscribe(channels, req, res);
  }
  forward(req, res).catch((e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `shim: ${e.message}` }));
  });
}).listen(PORT, () => console.log(`upstash shim on :${PORT} (SRH ${SRH}, redis ${REDIS_HOST}:${REDIS_PORT})`));
