/**
 * WebRTC lab server (`make rtc-lab`): serves the browser peer page and relays setup messages between the two peers
 * of a room over a WebSocket, nothing else. Peers report their results back on the same socket; they are appended to
 * `<out>/results.jsonl`. No HiveTeX code is involved, so the lab measures the network, the relay and the WebRTC stacks.
 *
 *   node server.mjs <port> <out dir>
 *   TURN_SERVER / TURN_USERNAME / TURN_CREDENTIAL   relay offered to the peers (never printed or logged)
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
// `ws` is a dependency of the server package; the lab borrows it rather than adding one of its own.
const { WebSocketServer } = createRequire(join(root, 'server', 'package.json'))('ws');

const port = Number(process.argv[2] ?? 3999);
const out = process.argv[3] ?? join(here, 'out');
mkdirSync(out, { recursive: true });
const results = join(out, 'results.jsonl');

const turnHost = process.env.TURN_SERVER?.replace(/^turns?:/, '').replace(/\?.*$/, '');
/** STUN always; TURN over UDP and/or TCP when configured (`turn=udp|tcp|both|none`). */
export function iceServers(turn = 'both') {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!turnHost || turn === 'none') return list;
  const entry = (transport) => ({ urls: `turn:${turnHost}?transport=${transport}`, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  if (turn !== 'tcp') list.push(entry('udp'));
  if (turn !== 'udp') list.push(entry('tcp'));
  return list;
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://lab');
  if (url.pathname === '/peer.html') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(readFileSync(join(here, 'peer.html')));
  }
  if (url.pathname === '/ice') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(iceServers(url.searchParams.get('turn') ?? 'both')));
  }
  if (url.pathname === '/health') return res.writeHead(200).end('ok');
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: http });
/** room -> sockets; every message goes to the other sockets of the room, except reports. */
const rooms = new Map();
wss.on('connection', (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://lab').searchParams.get('room') ?? 'default';
  const peers = rooms.get(room) ?? new Set();
  rooms.set(room, peers);
  peers.add(ws);
  ws.on('message', (data) => {
    const text = String(data);
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'result') {
      appendFileSync(results, `${JSON.stringify({ at: new Date().toISOString(), room, ...m })}\n`);
      return;
    }
    for (const other of peers) if (other !== ws && other.readyState === 1) other.send(text);
  });
  ws.on('close', () => peers.delete(ws));
});
http.listen(port, '0.0.0.0', () => console.log(`rtc-lab server on :${port} (relay ${turnHost ? 'configured' : 'not configured'})`));
