import { generateDeviceKeys } from '@hivetex/crypto';
import { RING_TOPIC_RE, RING_TYP } from '@hivetex/protocol';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.js';
import { createDevPush } from '../src/dev-push.js';
import { ringTopic } from '../src/projects/doorbell.js';
import { type Client, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv();
  env.deps.config.doorbellUrl = 'https://push.example';
});

async function device(c: Client) {
  const keys = await generateDeviceKeys();
  return (await c.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub })).json.deviceId as string;
}
async function setup() {
  const owner = await register(env, 'olga');
  const pid = (await owner.post('/projects', { slug: 'ring-project-1', password: 'project-secret-1' })).json.project.id as string;
  const bob = await register(env, 'bob');
  await bob.post('/projects/join', { slug: 'ring-project-1', password: 'project-secret-1' });
  const bobId = (await env.db.select().from(schema.users)).find((u) => u.username === 'bob')?.id as string;
  return { owner, bob, bobId, pid, od: await device(owner), bd: await device(bob) };
}

describe('doorbell topics and ring tokens (3B.1)', () => {
  it('returns an opaque topic with every ticket and moves it on an epoch change', async () => {
    const { owner, bob, bobId, pid, od, bd } = await setup();
    const t1 = (await owner.post(`/projects/${pid}/ticket`, { deviceId: od })).json;
    const t2 = (await bob.post(`/projects/${pid}/ticket`, { deviceId: bd })).json;
    expect(t1.doorbell).toEqual({ url: 'https://push.example', topic: expect.stringMatching(RING_TOPIC_RE) });
    expect(t2.doorbell.topic).toBe(t1.doorbell.topic); // one topic for the whole project
    expect(t1.doorbell.topic).not.toContain(pid);
    // Removing a member bumps the epoch: everyone remaining moves to a topic the removed member never learns.
    await owner.del(`/projects/${pid}/members/${bobId}`);
    const t3 = (await owner.post(`/projects/${pid}/ticket`, { deviceId: od })).json;
    expect(t3.epoch).toBe(t1.epoch + 1);
    expect(t3.doorbell.topic).not.toBe(t1.doorbell.topic);
    expect((await bob.post(`/projects/${pid}/ring`, { deviceId: bd })).status).toBe(403);
    expect((await bob.post(`/projects/${pid}/ticket`, { deviceId: bd })).status).toBe(403);
  });

  it('carries the desktop rollout switches with every ticket (12.3)', async () => {
    const { owner, pid, od } = await setup();
    expect((await owner.post(`/projects/${pid}/ticket`, { deviceId: od })).json.features).toBeUndefined();
    env.deps.config.desktopFeatures = { background: false, upnp: true };
    expect((await owner.post(`/projects/${pid}/ticket`, { deviceId: od })).json.features).toEqual({ background: false, upnp: true });
  });

  it('issues a minimal signed ring token for a member and rate-limits it per device', async () => {
    const { owner, pid, od } = await setup();
    const r = await owner.post(`/projects/${pid}/ring`, { deviceId: od });
    expect(r.status).toBe(200);
    const { token, topic, url } = r.json as { token: string; topic: string; url: string };
    expect(url).toBe('https://push.example');
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'EdDSA', typ: RING_TYP, kid: 'k1' });
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(['ep', 'exp', 'iat', 'n', 'topic', 'v']);
    expect(claims.topic).toBe(topic);
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(JSON.stringify(claims)).not.toContain(pid);
    const key = await importJWK(env.deps.config.ticketPublicJwks[0]?.jwk as never, 'EdDSA');
    await expect(jwtVerify(token, key, { currentDate: env.deps.now() })).resolves.toBeTruthy();
    // One ring per device and project per 20 s.
    const again = await owner.post(`/projects/${pid}/ring`, { deviceId: od });
    expect(again.status).toBe(429);
    env.advance(21_000);
    expect((await owner.post(`/projects/${pid}/ring`, { deviceId: od })).status).toBe(200);
  });

  it('refuses rings for another user\'s device, revoked devices and servers without a doorbell', async () => {
    const { owner, bob, pid, od, bd } = await setup();
    expect((await bob.post(`/projects/${pid}/ring`, { deviceId: od })).status).toBe(403);
    await bob.del(`/devices/${bd}`);
    expect((await bob.post(`/projects/${pid}/ring`, { deviceId: bd })).status).toBe(403);
    delete env.deps.config.doorbellUrl;
    expect((await owner.post(`/projects/${pid}/ring`, { deviceId: od })).status).toBe(404);
    expect((await owner.post(`/projects/${pid}/ticket`, { deviceId: od })).json.doorbell).toBeUndefined();
  });

  it('derives topics deterministically per project and epoch', () => {
    const cfg = env.deps.config;
    expect(ringTopic(cfg, 'p', 1)).toBe(ringTopic(cfg, 'p', 1));
    expect(ringTopic(cfg, 'p', 1)).not.toBe(ringTopic(cfg, 'p', 2));
    expect(ringTopic(cfg, 'p', 1)).not.toBe(ringTopic(cfg, 'q', 1));
    expect(ringTopic(cfg, 'p', 1)).toMatch(RING_TOPIC_RE);
  });
});

describe('dev push service (ntfy-compatible subset)', () => {
  it('streams published messages to current subscribers of any listed topic only', async () => {
    const push = createDevPush(50);
    const res = await push.app.request('/ta,tb/json');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const lines: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      }
    })();
    await push.app.request('/tb', { method: 'POST', body: 'ring-1' });
    await push.app.request('/tc', { method: 'POST', body: 'not-for-us' });
    await new Promise((r) => setTimeout(r, 80));
    await reader.cancel();
    await pump.catch(() => {});
    expect(lines[0]?.event).toBe('open');
    expect(lines.filter((l) => l.event === 'message').map((l) => [l.topic, l.message])).toEqual([['tb', 'ring-1']]);
    expect(lines.some((l) => l.event === 'keepalive')).toBe(true);
    expect(push.subscribers('ta')).toBe(0);
  });
});
