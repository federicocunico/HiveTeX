import type { Role } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type MergeReport, OfflineFork, forkMeshOptions, listenForkStatus } from '../src/fork.js';
import { MemoryPersistence, type Persistence } from '../src/persistence.js';
import { waitFor } from './helpers.js';
import { Net, type Node, converged, text } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

type FNode = Node & { fork: OfflineFork; reports: MergeReport[] };

async function addNode(name: string, role: Role, store?: Persistence): Promise<FNode> {
  const holder: { fork?: OfflineFork } = {};
  const n = await net.add(name, role, { ...(store ? { store } : {}), meshOpts: { beforeSync: (p: { deviceId: string }) => holder.fork?.beforeSync(p) ?? Promise.resolve() } });
  const reports: MergeReport[] = [];
  const fork = new OfflineFork({
    model: n.model,
    canEdit: () => role !== 'viewer',
    onReport: (r) => reports.push(r),
    statusTimeoutMs: 500,
    ...forkMeshOptions(() => n.mesh, () => n.dev, 1500),
  });
  await fork.start();
  listenForkStatus(n.mesh, fork);
  holder.fork = fork;
  return Object.assign(n, { fork, reports });
}

const BASE = 'intro\nmethod\nresults\nconclusion\n';

async function setup() {
  net = await Net.create();
  const a = await addNode('alice', 'owner');
  const b = await addNode('bob', 'editor');
  await net.link(a, b);
  const id = await a.model.createTextNow('main.tex', BASE);
  await converged([a, b], id);
  return { a, b, id };
}

async function separate(a: FNode, b: FNode) {
  net.isolate(a);
  await waitFor(() => a.mesh.peers.length === 0 && b.mesh.peers.length === 0);
}

async function edit(n: FNode, id: string, from: string, to: string) {
  const t = await n.model.openText(id);
  const s = t.toString();
  const i = s.indexOf(from);
  t.doc?.transact(() => {
    t.delete(i, from.length);
    t.insert(i, to);
  });
}

describe('offline fork: git-style merge on reconnect', () => {
  it('edits made while linked never start a fork; edits made alone do', async () => {
    const { a, b, id } = await setup();
    await edit(a, id, 'intro', 'Intro');
    expect(a.fork.active).toBe(false);
    await separate(a, b);
    await edit(a, id, 'Intro', 'INTRO');
    expect(a.fork.active).toBe(true);
  });

  it('a file changed on one side only is taken as it is, without a warning', async () => {
    const { a, b, id } = await setup();
    await separate(a, b);
    await edit(a, id, 'method', 'METHOD');
    await net.link(a, b);
    await waitFor(async () => (await text(b, id)).includes('METHOD'), 5000);
    await converged([a, b], id);
    expect(a.reports.at(-1)).toMatchObject({ merged: [], taken: ['main.tex'], conflicts: 0 });
    expect(a.fork.active).toBe(false);
  });

  it('changes to different lines merge on both devices, with a warning listing the file', async () => {
    const { a, b, id } = await setup();
    await separate(a, b);
    await edit(a, id, 'intro', 'INTRO');
    await edit(b, id, 'conclusion', 'CONCLUSION');
    await net.link(a, b);
    await waitFor(async () => (await text(a, id)) === 'INTRO\nmethod\nresults\nCONCLUSION\n' && (await text(b, id)) === 'INTRO\nmethod\nresults\nCONCLUSION\n', 5000);
    // exactly one of the two devices merged (the other shared its work as it was)
    const merges = [...a.reports, ...b.reports].filter((r) => r.merged.includes('main.tex'));
    expect(merges).toHaveLength(1);
  });

  it('changes to the same lines become a conflict on one device; the other keeps its version until it is resolved', async () => {
    const { a, b, id } = await setup();
    await separate(a, b);
    await edit(a, id, 'method', 'method by alice');
    await edit(b, id, 'method', 'method by bob');
    await net.link(a, b);
    const merger = await waitFor(() => a.fork.conflicts.length + b.fork.conflicts.length === 1, 5000).then(() => (a.fork.conflicts.length ? a : b));
    const other = merger === a ? b : a;
    const c = merger.fork.conflicts[0];
    expect(c?.kind).toBe('text');
    // nothing of the merger's conflicting version reached the other device
    const mine = merger === a ? 'alice' : 'bob';
    const theirs = merger === a ? 'bob' : 'alice';
    expect(await text(other, id)).toBe(`intro\nmethod by ${theirs}\nresults\nconclusion\n`);
    expect(await text(merger, id)).toBe(`intro\nmethod by ${theirs}\nresults\nconclusion\n`);
    // keep both: mine first, then theirs, shared with the other device
    expect(await merger.fork.resolveText((c as { id: string }).id, ['both'])).toBe('resolved');
    const want = `intro\nmethod by ${mine}\nmethod by ${theirs}\nresults\nconclusion\n`;
    await waitFor(async () => (await text(other, id)) === want, 5000);
    expect(merger.fork.conflicts).toHaveLength(0);
  });

  it('resolving keeps what the others wrote meanwhile elsewhere in the file', async () => {
    const { a, b, id } = await setup();
    await net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0);
    await edit(a, id, 'method', 'method A');
    // bob keeps working with a third device, so he is not alone (no fork on his side)
    const c3 = await addNode('carol', 'editor');
    await net.link(b, c3);
    await edit(b, id, 'method', 'method B');
    await net.link(a, b);
    await waitFor(() => a.fork.conflicts.length === 1, 5000);
    await edit(b, id, 'conclusion', 'the end');
    await waitFor(async () => (await text(a, id)).includes('the end'), 5000);
    expect(await a.fork.resolveText(a.fork.conflicts[0]?.id as string, ['mine'])).toBe('resolved');
    await waitFor(async () => (await text(b, id)) === 'intro\nmethod A\nresults\nthe end\n', 5000);
  });

  it('a pending conflict survives a restart', async () => {
    net = await Net.create();
    const store = new MemoryPersistence();
    const a = await addNode('alice', 'owner', store);
    const b = await addNode('bob', 'editor');
    const c3 = await addNode('carol', 'editor');
    await net.link(a, b);
    await net.link(b, c3);
    const id = await a.model.createTextNow('main.tex', BASE);
    await converged([a, b], id);
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0);
    await edit(a, id, 'results', 'results A');
    await edit(b, id, 'results', 'results B');
    await net.link(a, b);
    await waitFor(() => a.fork.conflicts.length === 1, 5000);
    await a.model.flush();
    a.fork.stop();
    const again = new OfflineFork({ model: a.model, isLinked: () => true, canEdit: () => true, waitSynced: async () => {} });
    await again.start();
    expect(again.conflicts).toHaveLength(1);
    expect(again.conflicts[0]).toMatchObject({ kind: 'text', path: 'main.tex' });
  });

  it('a fork made before a restart is merged at the next link', async () => {
    net = await Net.create();
    const store = new MemoryPersistence();
    const a = await addNode('alice', 'owner', store);
    const b = await addNode('bob', 'editor');
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', BASE);
    await converged([a, b], id);
    await separate(a, b);
    await edit(a, id, 'intro', 'INTRO');
    await a.model.flush();
    a.fork.stop();
    a.mesh.destroy();
    // the app restarts on the same storage
    const a2 = await addNode('alice', 'owner', store);
    expect(a2.fork.active).toBe(true);
    await net.link(a2, b);
    await waitFor(async () => (await text(b, id)).startsWith('INTRO'), 5000);
  });

  it('delete here vs edit there, and rename vs rename, are file conflicts', async () => {
    const { a, b, id } = await setup();
    const id2 = await a.model.createTextNow('ch2.tex', 'two\n');
    await converged([a, b], id2);
    const c3 = await addNode('carol', 'editor');
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0);
    await net.link(b, c3);
    a.model.delete(id);
    await edit(b, id, 'results', 'RESULTS');
    a.model.rename(id2, 'chapters/two.tex');
    b.model.rename(id2, 'part2.tex');
    await net.link(a, b);
    await waitFor(() => a.fork.conflicts.length === 2, 5000);
    const types = a.fork.conflicts.map((c) => (c.kind === 'file' ? c.conflict.type : c.kind)).sort();
    expect(types).toEqual(['delete-modify', 'rename-rename']);
    // their file stays until decided
    expect(b.model.byId(id)).toBeTruthy();
    const rr = a.fork.conflicts.find((c) => c.kind === 'file' && c.conflict.type === 'rename-rename');
    await a.fork.resolveFile(rr?.id as string, 'mine');
    await waitFor(() => b.model.byId(id2)?.path === 'chapters/two.tex', 5000);
    const dm = a.fork.conflicts.find((c) => c.kind === 'file' && c.conflict.type === 'delete-modify');
    await a.fork.resolveFile(dm?.id as string, 'delete');
    await waitFor(() => !b.model.byId(id), 5000);
  });

  it('a binary changed on both sides is a conflict, decided with a version', async () => {
    const { a, b } = await setup();
    const img = a.model.createBinary('fig.png', 'h0', 10);
    await waitFor(() => !!b.model.byId(img));
    const c3 = await addNode('carol', 'editor');
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0);
    await net.link(b, c3);
    a.model.setBinary(img, 'h1', 11);
    b.model.setBinary(img, 'h2', 12);
    await net.link(a, b);
    await waitFor(() => a.fork.conflicts.length === 1, 5000);
    const c = a.fork.conflicts[0];
    expect(c?.kind === 'file' && c.conflict).toMatchObject({ type: 'binary', mine: 'h1', theirs: 'h2' });
    expect(b.model.byId(img)?.hash).toBe('h2');
    await a.fork.resolveFile(c?.id as string, 'mine');
    await waitFor(() => b.model.byId(img)?.hash === 'h1', 5000);
  });

  it('a file added offline is added for everyone', async () => {
    const { a, b } = await setup();
    await separate(a, b);
    const nid = await a.model.createTextNow('appendix.tex', 'Appendix\n');
    await net.link(a, b);
    await waitFor(() => !!b.model.byId(nid), 5000);
    await converged([a, b], nid);
    expect(await text(b, nid)).toBe('Appendix\n');
  });

  it('merges another copy with no common history: new files added, differing ones become whole-file conflicts', async () => {
    const { a, id } = await setup();
    const r = await a.fork.mergeIn([
      { path: 'main.tex', kind: 'text', text: 'a different main\n' },
      { path: 'extra.tex', kind: 'text', text: 'extra\n' },
    ]);
    expect(r.taken).toContain('extra.tex');
    expect(a.fork.conflicts).toHaveLength(1);
    const c = a.fork.conflicts[0];
    expect(c).toMatchObject({ kind: 'text', fileId: id, path: 'main.tex' });
    await a.fork.resolveText(c?.id as string, ['mine']);
    expect(await text(a, id)).toBe('a different main\n');
    expect(a.model.find('extra.tex')).toBeTruthy();
  });
});
