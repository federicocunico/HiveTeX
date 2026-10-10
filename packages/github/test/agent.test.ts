import { BlobManager } from '@hivetex/sync';
import { Net, type Node } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupAgent, DEFAULT_POLICY, decide, emptyMeta } from '../src/index.js';
import { FakeGitHub } from '../src/testing.js';

let net: Net;
const agents: BackupAgent[] = [];
afterEach(() => {
  for (const a of agents.splice(0)) a.stop();
  net?.destroy();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

describe('backup policy decisions (10.4)', () => {
  const policy = { ...DEFAULT_POLICY, idleMinutes: 15, everyChanges: 20, minIntervalMinutes: 5 };
  const meta = (o: object) => ({ ...emptyMeta(), ...o });
  const MIN = 60_000;

  it('waits when nothing changed', () => {
    expect(decide(policy, meta({ changesSince: 0 }), 10_000 * MIN)).toBe('wait');
  });
  it('backs up after the idle time following a change', () => {
    const m = meta({ changesSince: 3, lastChangeAt: 100 * MIN, lastBackupAt: 0 });
    expect(decide(policy, m, 110 * MIN)).toBe('wait');
    expect(decide(policy, m, 116 * MIN)).toBe('backup');
  });
  it('backs up after N changes, respecting the minimum interval', () => {
    const m = meta({ changesSince: 20, lastChangeAt: 100 * MIN, lastBackupAt: 98 * MIN });
    expect(decide(policy, m, 101 * MIN)).toBe('wait');
    expect(decide(policy, m, 104 * MIN)).toBe('backup');
  });
  it('does nothing when disabled; manual backup works when there are changes or no backup yet', () => {
    expect(decide({ ...policy, enabled: false }, meta({ changesSince: 99, lastChangeAt: 0 }), 1e12)).toBe('wait');
    expect(decide(policy, meta({ changesSince: 1 }), 0, true)).toBe('backup');
    expect(decide(policy, meta({ changesSince: 0, lastSha: 'abc' }), 0, true)).toBe('wait');
  });
});

async function device(
  name: string,
  role: 'owner' | 'editor',
  gh: FakeGitHub,
  token: { value: string | null },
  clock: { t: number },
) {
  const n: Node = await net.add(name, role);
  const blobs = new BlobManager(n.mesh, n.store);
  const agent = new BackupAgent({
    mesh: n.mesh,
    model: n.model,
    blobs,
    self: { dev: n.dev, uname: name },
    getRole: () => role,
    getToken: async () => token.value,
    fetchImpl: gh.fetch,
    now: () => clock.t,
    tickMs: 1_000_000,
  });
  agents.push(agent);
  agent.start();
  return { n, agent };
}

describe('backup agent: scheduling and writer election (10.4, 10.5)', () => {
  it('commits after the idle period and again after the change count, with contributor names', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    gh.repo('octocat/paper', { empty: true });
    const clock = { t: Date.UTC(2026, 0, 1, 10, 0) };
    const { n, agent } = await device('alice', 'owner', gh, { value: 'tok' }, clock);
    await sleep(30);
    agent.setBinding({ repo: { owner: 'octocat', repo: 'paper' }, branch: 'main' });
    agent.setPolicy({ idleMinutes: 15, everyChanges: 3, minIntervalMinutes: 5 });
    const id = await n.model.createTextNow('main.tex', 'v1');

    await agent.tick();
    expect(agent.pushes).toBe(0); // just edited: not idle yet
    clock.t += 16 * 60_000;
    await agent.tick();
    expect(agent.pushes).toBe(1);
    expect(gh.repo('octocat/paper').files('main')['main.tex']).toBe('v1');
    const head = gh.repo('octocat/paper').refs.get('main') as string;
    expect(gh.repo('octocat/paper').commits.get(head)?.message).toContain('alice');

    // N-changes trigger (no idle wait), but only after the minimum interval
    const t = await n.model.openText(id);
    for (let i = 0; i < 4; i++) t.insert(t.length, 'x');
    await agent.tick();
    expect(agent.pushes).toBe(1); // 0 min since the last backup
    clock.t += 6 * 60_000;
    await agent.tick();
    expect(agent.pushes).toBe(2);
    expect(gh.repo('octocat/paper').files('main')['main.tex']).toBe('v1xxxx');

    // idle again with nothing new => no further commits
    clock.t += 60 * 60_000;
    await agent.tick();
    expect(agent.pushes).toBe(2);
  });

  it('exactly one of two owners pushes each backup, and the other takes over when the token disappears', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    gh.repo('octocat/paper', { empty: true });
    const clock = { t: Date.UTC(2026, 0, 1, 10, 0) };
    const tokA = { value: 'tokA' as string | null };
    const tokB = { value: 'tokB' as string | null };
    const a = await device('alice', 'owner', gh, tokA, clock);
    const b = await device('bob', 'owner', gh, tokB, clock);
    await net.link(a.n, b.n);
    await sleep(100);
    a.agent.setBinding({ repo: { owner: 'octocat', repo: 'paper' }, branch: 'main' });
    await waitFor(() => !!b.agent.binding);
    const writer = a.agent.writer();
    expect(writer).toBe(b.agent.writer());
    const [w, other] = writer === a.n.dev ? [a, b] : [b, a];
    expect(w.agent.isWriter()).toBe(true);
    expect(other.agent.isWriter()).toBe(false);

    await w.n.model.createTextNow('main.tex', 'draft');
    await waitFor(() => other.n.model.list().length === 1);
    clock.t += 20 * 60_000;
    await Promise.all([a.agent.tick(), b.agent.tick()]);
    expect(a.agent.pushes + b.agent.pushes).toBe(1);
    expect(w.agent.pushes).toBe(1);

    // the writer's token is revoked: it steps down and the other device takes over
    (writer === a.n.dev ? tokA : tokB).value = null;
    await w.agent.tokenChanged();
    await waitFor(() => other.agent.isWriter());
    const id = other.n.model.find('main.tex')?.id as string;
    await other.n.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await other.n.model.openText(id)).toString() === 'draft');
    (await other.n.model.openText(id)).insert(5, ' + more');
    clock.t += 20 * 60_000;
    await Promise.all([a.agent.tick(), b.agent.tick()]);
    expect(other.agent.pushes).toBe(1);
    expect(gh.repo('octocat/paper').files('main')['main.tex']).toBe('draft + more');
  });

  it('prefers owners over editors and ignores devices without a token', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    const clock = { t: 1 };
    const ed = await device('eddie', 'editor', gh, { value: 'tok' }, clock);
    const ow = await device('olga', 'owner', gh, { value: 'tok' }, clock);
    const nt = await device('nora', 'owner', gh, { value: null }, clock);
    await net.fullMesh();
    await sleep(100);
    for (const d of [ed, ow, nt]) expect(d.agent.writer()).toBe(ow.n.dev);
  });

  it('reports an expired authorization and steps down', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    gh.repo('octocat/paper', { empty: true });
    const clock = { t: 1_000_000 };
    const tok = { value: 'tok' as string | null };
    const { n, agent } = await device('alice', 'owner', gh, tok, clock);
    await sleep(30);
    agent.setBinding({ repo: { owner: 'octocat', repo: 'paper' }, branch: 'main' });
    await n.model.createTextNow('main.tex', 'x');
    tok.value = null;
    await expect(agent.backupNow()).rejects.toThrow(/authorization expired/);
    expect(agent.meta.lastError).toMatch(/authorization expired/);
    expect(agent.isWriter()).toBe(false);
  });

  it('only owners may change the binding or policy', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    const { agent } = await device('eddie', 'editor', gh, { value: 'tok' }, { t: 1 });
    expect(() => agent.setBinding({ repo: { owner: 'a', repo: 'b' }, branch: 'main' })).toThrow(/Only owners/);
    expect(() => agent.setPolicy({ idleMinutes: 1 })).toThrow(/Only owners/);
  });
});

describe('backup binding authority (security)', () => {
  it('never pushes to a binding an editor wrote into the shared metadata', async () => {
    net = await Net.create();
    const gh = new FakeGitHub();
    gh.repo('owner/paper', { empty: true });
    gh.repo('owner/other-private-repo', { empty: true });
    const clock = { t: Date.UTC(2026, 0, 1, 10, 0) };
    const owner = await net.add('olga', 'owner');
    const editor = await net.add('eve', 'editor');
    await net.link(owner, editor);
    const authorized = { value: 'owner/paper@main' as string | null };
    const agent = new BackupAgent({
      mesh: owner.mesh,
      model: owner.model,
      blobs: new BlobManager(owner.mesh, owner.store),
      self: { dev: owner.dev, uname: 'olga' },
      getRole: () => 'owner',
      getToken: async () => 'owner-token',
      fetchImpl: gh.fetch,
      now: () => clock.t,
      tickMs: 1_000_000,
      authorizedBinding: () => authorized.value,
    });
    agents.push(agent);
    agent.start();
    await owner.model.createTextNow('main.tex', 'secret draft');

    // a modified editor client rewrites the shared binding to another repository the owner can write
    editor.model.meta.set('backupBinding', JSON.stringify({ repo: { owner: 'owner', repo: 'other-private-repo' }, branch: 'main' }));
    await waitFor(() => agent.binding?.repo.repo === 'other-private-repo');
    expect(agent.bindingMismatch).toBe(true);
    clock.t += 60 * 60_000;
    await agent.tick();
    await expect(agent.backupNow()).rejects.toThrow(/not set by an owner/);
    expect(agent.pushes).toBe(0);
    expect(gh.repo('owner/other-private-repo').refs.size).toBe(0);

    // the owner's own binding (matching the control plane) works
    agent.setBinding({ repo: { owner: 'owner', repo: 'paper' }, branch: 'main' });
    expect(agent.bindingMismatch).toBe(false);
    await agent.backupNow();
    expect(gh.repo('owner/paper').files('main')['main.tex']).toBe('secret draft');
  });
});
