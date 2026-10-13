import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { createProject, joinProject, newUser, uniq } from './helpers.js';

// 13.7: run against server/scripts/relay-acceptance-server.ts, not a production deployment.
test.skip(process.env.RELAY_ACCEPTANCE !== '1', 'requires the local two-instance Redis-backed loss/rotation fixture');
type Session = {
  model: { createTextNow(path: string, text: string): Promise<string>; createBinary(path: string, hash: string, size: number): void; openText(id: string): Promise<{ length: number; insert(i: number, s: string): void; toString(): string }> };
  blobs: { add(bytes: Uint8Array): Promise<string>; has(hash: string): Promise<boolean> };
  peers: Array<{ route: string }>;
  mesh: { peers: Array<{ conn: { transport: { authenticationBinding: { kind: string; transcriptHash: string } } } }> };
};
const session = (p: import('@playwright/test').Page) => p.evaluate(() => {
  const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
  const binding = s.mesh.peers[0]?.conn.transport.authenticationBinding;
  return { session: binding?.transcriptHash, kind: binding?.kind, routes: s.peers.map((p) => p.route), connectedRtc: (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((p) => p.connectionState === 'connected').length };
});

test('relay-only browsers recover payload loss and actual 300-second rotation onto another instance', async ({ browser, request }, info) => {
  test.setTimeout(450_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const initial = await (await request.get('/api/__dev/acceptance')).json();
  try {
    for (const c of contexts) await c.addInitScript(() => {
      // Production reconnects proactively at 280 s. This fixture delays that one timer so the real 300 s
      // server duration limit, rather than the proactive path, triggers recovery.
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => timeout(handler, ms === 280_000 ? 310_000 : ms, ...args)) as typeof window.setTimeout;
      const Original = window.RTCPeerConnection;
      const pcs: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
      window.RTCPeerConnection = class extends Original {
        constructor(cfg?: RTCConfiguration) { super({ ...cfg, iceServers: [], iceTransportPolicy: 'relay' }); pcs.push(this); }
      } as typeof RTCPeerConnection;
    });
    const [a, b] = await Promise.all(contexts.map((c, i) => newUser(c, `rot${i}`)));
    let slug = uniq('rotation-');
    slug = await createProject(a!.page, slug);
    await a!.page.getByTestId('settings-btn').click();
    await a!.page.getByLabel('Default role').selectOption('editor');
    await a!.page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await a!.page.getByTestId('settings-dialog').getByText('Saved', { exact: true }).waitFor();
    await a!.page.getByRole('button', { name: 'Close' }).click();
    const data = await a!.page.evaluate(async () => {
      const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
      const id = await s.model.createTextNow('main.tex', 'before rotation');
      const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
      const hash = await s.blobs.add(bytes);
      s.model.createBinary('fig.png', hash, bytes.length);
      return { id, hash };
    });
    await joinProject(b!.page, slug);
    await expect.poll(() => b!.page.evaluate(async ({ id, hash }) => {
      const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
      return (await s.model.openText(id)).toString() === 'before rotation' && await s.blobs.has(hash);
    }, data), { timeout: 90_000 }).toBe(true);
    const before = await session(a!.page);
    expect(before.routes).toEqual(['relay']); expect(before.connectedRtc).toBe(0);
    expect(before.kind).toBe('relay'); expect(before.session).toBeTruthy();
    expect((await session(b!.page)).connectedRtc).toBe(0);
    // Payload and ACK loss are active throughout; all inserts must arrive exactly once.
    await a!.page.evaluate(async (id) => {
      const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
      const t = await s.model.openText(id);
      for (let k = 0; k < 40; k++) { t.insert(t.length, ` <${k}>`); await new Promise((r) => setTimeout(r, 20)); }
    }, data.id);
    await expect.poll(() => b!.page.evaluate(async (id) => (await (window as unknown as { __p2p: { session: Session } }).__p2p.session.model.openText(id)).toString(), data.id), { timeout: 90_000 }).toContain('<39>');
    const metrics = async () => (await request.get('/api/__dev/acceptance')).json();
    if (process.env.RELAY_FORCE_ROTATION === '1') expect((await request.post('/api/__dev/rotate', { headers: { 'x-requested-with': 'hivetex', origin: new URL(process.env.PLAYWRIGHT_BASE_URL!).origin } })).ok()).toBe(true);
    else await expect.poll(async () => (await metrics()).rotations, { timeout: 330_000, intervals: [1000] }).toBeGreaterThan(initial.rotations);
    await a!.page.evaluate(async (id) => {
      const t = await (window as unknown as { __p2p: { session: Session } }).__p2p.session.model.openText(id);
      t.insert(t.length, ' during rotation');
    }, data.id);
    await expect.poll(async () => {
      const next = await session(a!.page);
      return !!next.session && next.session !== before.session && next.routes[0] === 'relay';
    }, { timeout: 90_000 }).toBe(true);
    await expect.poll(() => b!.page.evaluate(async (id) => (await (window as unknown as { __p2p: { session: Session } }).__p2p.session.model.openText(id)).toString(), data.id), { timeout: 90_000 }).toContain('during rotation');
    const final = await b!.page.evaluate(async ({ id, hash }) => {
      const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
      return { text: (await s.model.openText(id)).toString(), asset: await s.blobs.has(hash) };
    }, data);
    for (let k = 0; k < 40; k++) expect(final.text.split(`<${k}>`)).toHaveLength(2);
    expect(final.asset).toBe(true);
    expect((await session(a!.page)).connectedRtc + (await session(b!.page)).connectedRtc).toBe(0);
    const evidence = await metrics();
    expect(evidence.connections.every((n: number, i: number) => n > initial.connections[i])).toBe(true);
    expect(evidence.droppedPayloads).toBeGreaterThan(initial.droppedPayloads);
    if (process.env.RELAY_FORCE_ROTATION !== '1') expect(evidence.socketLifetimesMs.slice(initial.socketLifetimesMs.length).some((ms: number) => ms >= 299_000)).toBe(true);
    await info.attach('relay-recovery.json', { body: JSON.stringify(evidence), contentType: 'application/json' });
    console.log(`[relay recovery] rotations=${evidence.rotations}, dropped payloads=${evidence.droppedPayloads}, instance connections=${evidence.connections.join('/')}`);
  } finally {
    const diagnostics = await Promise.all(contexts.map(async (c) => c.pages()[0]?.evaluate(async () => {
      const s = (window as unknown as { __p2p?: { session: Session & { role: string; unsharedWork: boolean; conflicts: unknown[]; mergeError: unknown; syncStatus: unknown; runtime: { managerDiagnostics: unknown } } } }).__p2p?.session;
      if (!s) return null;
      return { routes: s.peers.map((p) => p.route), role: s.role, unsharedWork: s.unsharedWork, conflicts: s.conflicts,
        mergeError: s.mergeError && String(s.mergeError), syncStatus: s.syncStatus, manager: s.runtime.managerDiagnostics,
        text: (await s.model.openText((s.model as unknown as { find(p: string): { id: string } }).find('main.tex').id)).toString() };
    }).catch(() => null)));
    await info.attach('endpoint-diagnostics.json', { body: JSON.stringify(diagnostics), contentType: 'application/json' });
    console.log('[relay recovery endpoints] ' + JSON.stringify(diagnostics.map((d) => d && ({ routes: d.routes, unsharedWork: d.unsharedWork, conflicts: d.conflicts.length, mergeError: d.mergeError }))));
    await Promise.all(contexts.map((c) => c.close()));
  }
});
