/**
 * The desktop's headless sync worker (D1). Started by the native supervisor with the bundled Node runtime, it talks
 * only over its inherited stdin/stdout pipes (worker-ipc.ts framing) and exits when stdin closes, so it can never
 * outlive the supervisor. No DOM, no localhost server, no shell. Runtimes (packages/sync/src/runtime.ts) are hosted
 * here as the desktop migration proceeds; this entry carries the protocol and lifecycle.
 */
import { WorkerProjects } from './projects.js';
import { TransferScheduler } from '../transfer-budget.js';
import { nativeProjects } from './native.js';
import { SeedCatalog, type SeedData } from './catalog.js';
import { SharedPushChannels } from '../shared-push.js';
import { decodeValue, encodeValue, storeScope } from '../native-persistence.js';
import { MAX_FRAME, MAX_MESSAGE, ProtocolError, RpcEndpoint, redactDiagnostics, WORKER_PROTOCOL } from '../worker-ipc.js';

/** Diagnostics on stderr, always redacted (no tokens, keys or topics). */
const log = (line: string) => process.stderr.write(`hivetex-worker: ${redactDiagnostics(line)}\n`);

const gen = Number(process.env.HIVETEX_WORKER_GEN ?? '0');
if (!Number.isSafeInteger(gen) || gen < 0) process.exit(64);
if (typeof (globalThis as { window?: unknown }).window !== 'undefined' || typeof (globalThis as { document?: unknown }).document !== 'undefined') process.exit(65);

let exiting = false;
async function shutdown(code: number, pipeGone = false) {
  if (exiting) return;
  exiting = true;
  projects.freeze();
  if (pipeGone) rpc.close();
  await catalog.close().catch(() => {});
  push.close();
  await projects.stop().catch(() => {});
  rpc.close();
  // Let a last frame drain, then leave.
  setTimeout(() => process.exit(code), 20).unref();
}

const rpc = new RpcEndpoint({
  gen,
  write: (frame) => {
    if (process.stdout.writableLength + frame.length > MAX_MESSAGE + MAX_FRAME) throw new ProtocolError('frame_too_large', 'worker output queue full');
    process.stdout.write(frame);
  },
  // A framing error means the stream can no longer be trusted: exit and let the supervisor restart a fresh generation.
  onFatal: (e: ProtocolError) => {
    log(`protocol error ${e.code}`);
    shutdown(66);
  },
});

const push = new SharedPushChannels();
// One budget for every seed and attached project of this device (D8): slots, receive buffer, pacing, disk.
const storage = () => rpc.request<{ free: number | null; retained: number }>('native.call', { cmd: 'storage_status', args: {}, project: '' });
const transfers = new TransferScheduler({}, {
  freeBytes: () => storage().then((s) => s.free, () => null),
  retainedBytes: () => storage().then((s) => s.retained, () => 0),
});
let liveSession: { origin: string; account: string; token: string } | null = null;
const sessionFor = (profile: { server: string; account: string }) =>
  liveSession?.origin === new URL(profile.server).origin && liveSession.account === profile.account ? liveSession.token : undefined;
const projects: WorkerProjects = new WorkerProjects({
  create: nativeProjects(rpc, push, { scheduler: transfers, foreground: (p) => projects.registry.demand(p).includes('editor') }, sessionFor),
  emit: (event, data) => { rpc.emit('project.'+event, encodeValue(data)); syncUpnp(); },
  opened: (p, r) => catalog.opened(p, r),
  detached: (p, r) => catalog.detached(p, r),
  ticket: (p, r, answer) => catalog.ticket(p, r, answer),
  stopping: () => catalog.deactivate(),
  pause: (p, paused) => catalog.pause(p, paused),
  authorize: (p) => catalog.authorize(p),
  freezing: () => catalog.freeze(),
});
const native = <T>(cmd: string, args: unknown = {}) => rpc.request<T>('native.call', { cmd, args, project: '' });
const catalog: SeedCatalog = new SeedCatalog({
  host: projects, push,
  load: () => native<SeedData>('catalog_load'),
  save: (value) => native('catalog_save', { value }),
  session: (profile, session) => { liveSession = profile && session ? { origin: new URL(profile.server).origin, account: profile.account, token: session.token } : null; },
  credentials: async (profile) => !!(sessionFor(profile) ?? await native('secret_get', { key: 'session-token:' + new URL(profile.server).origin }))
    && !!(await native('secret_get', { key: 'device:' + await storeScope(profile.server, profile.account, 'identity') })),
  emit: () => { rpc.emit('catalog.change', encodeValue(null)); syncUpnp(); },
});
// Router port mapping runs natively only while a signed-in account actively syncs (D7); the native side owns cleanup.
let upnpOn = false;
function syncUpnp() {
  const want = catalog.upnpWanted();
  if (want === upnpOn) return;
  upnpOn = want;
  void native('upnp_set', { enabled: want }).catch(() => { upnpOn = !want; });
}
projects.install(rpc);
catalog.install(rpc);
rpc.on('native.resume', (event) => {
  const online = (event as { online?: boolean }).online !== false;
  void (online ? catalog.resume() : catalog.networkLost()).catch(() => {});
});

rpc.on('native.renderer', (event) => {
  if ((event as { closed?: boolean }).closed) void projects.detachAll();
});
// Explicit Quit (tray or window): flush everything durably first. With failures the app stays open and shows the
// recovery choices; only an explicit discard decision quits anyway.
rpc.handle('app.quit', async (wire) => {
  const discard = typeof wire === 'string' && (decodeValue(wire) as { discard?: boolean } | null)?.discard === true;
  const failing = await projects.flushAll();
  if (failing.length && !discard) return encodeValue({ ok: false, failing });
  setTimeout(() => void shutdown(0), 0);
  return encodeValue({ ok: true, failing });
});
rpc.handle('hello', () => ({ protocol: WORKER_PROTOCOL, gen, node: process.version, maxFrame: MAX_FRAME, maxMessage: MAX_MESSAGE, pid: process.pid }));
rpc.handle('ping', (p) => ({ pong: p ?? null, at: Date.now() }));
rpc.handle('shutdown', () => {
  setTimeout(() => shutdown(0), 0);
  return { ok: true };
});
if (process.env.HIVETEX_WORKER_TEST === '1') {
  // Test-only: a slow method to exercise cancellation.
  rpc.handle('test.sleep', (p, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ slept: p }), Number(p) || 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  }));
}

process.stdin.on('data', (chunk: Buffer) => rpc.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
// Pipe EOF: the supervisor went away (or closed us on purpose). Never keep running without it.
process.stdin.on('end', () => shutdown(0, true));
process.stdin.on('error', () => shutdown(0, true));
process.on('uncaughtException', (e) => {
  log(e instanceof Error ? e.message : String(e));
  // Where it failed: the first distinct frames (a recursion shows its loop once), each a diagnostic line of its own.
  const frames = e instanceof Error ? (e.stack ?? '').split('\n').slice(1).map((l) => l.trim()) : [];
  for (const frame of frames.filter((l, i) => l && l !== frames[i - 1]).slice(0, 15)) log(frame);
  shutdown(70);
});
rpc.emit('ready', { protocol: WORKER_PROTOCOL, gen });
