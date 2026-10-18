import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { type FsAdapter, MirrorSync, scanFs } from '../src/mirror.js';
import { Net, waitFor } from '../src/testkit.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => b && new TextDecoder().decode(b);
let net: Net;
const mirrors: MirrorSync[] = [];
afterEach(() => { for (const m of mirrors.splice(0)) m.stop(); net?.destroy(); });

async function setup() {
  net = await Net.create();
  const n = await net.add('owner', 'owner');
  const id = await n.model.createTextNow('main.tex', 'original');
  const disk = new Map<string, Uint8Array>([['main.tex', enc('original')]]);
  let notify: (e: { path: string }) => void = () => {};
  let readError: Error | null = null;
  const notices: string[] = [];
  const fs: FsAdapter = {
    list: async () => [...disk].map(([path, b]) => ({ path, size: b.length })),
    read: async (path) => { if (readError) throw readError; return disk.get(path) ?? null; },
    write: async (path, b) => { disk.set(path, b); },
    remove: async (path) => { disk.delete(path); },
    watch: (cb) => { notify = cb; return () => {}; },
  };
  const mirror = new MirrorSync({ model: n.model, mesh: n.mesh, blobs: new BlobManager(n.mesh, n.store), fs, getRole: () => n.role, debounceMs: 1, retryMs: 20, onNotice: (s) => notices.push(s) });
  mirrors.push(mirror);
  await mirror.start();
  return { n, id, disk, notices, mirror, notify: () => notify({ path: 'main.tex' }), fail: (e: Error | null) => { readError = e; } };
}

describe('folder data safety', () => {
  it('holds colliding names and resumes both writes after an explicit rename resolves the collision', async () => {
    net = await Net.create(); const n = await net.add('owner', 'owner');
    await n.model.createTextNow('Intro.tex', 'uppercase version');
    const lower = await n.model.createTextNow('intro.tex', 'lowercase version');
    const disk = new Map<string, Uint8Array>();
    const fs: FsAdapter = { list: async () => [...disk].map(([path,b]) => ({path,size:b.length})), read:async(path) => disk.get(path) ?? null,
      write: async(path,b) => {disk.set(path,b);}, remove: async(path) => {disk.delete(path);}, watch:()=>()=>{} };
    const mirror = new MirrorSync({model:n.model,mesh:n.mesh,blobs:new BlobManager(n.mesh,n.store),fs,getRole:()=>n.role}); mirrors.push(mirror);
    await mirror.start(); expect(disk.size).toBe(0);
    n.model.rename(lower, 'renamed.tex');
    await waitFor(() => disk.has('Intro.tex') && disk.has('renamed.tex'));
    expect(dec(disk.get('Intro.tex'))).toBe('uppercase version'); expect(dec(disk.get('renamed.tex'))).toBe('lowercase version');
  });
  it('does not initialize from an incomplete scan and resumes after access recovers', async () => {
    net = await Net.create(); const n = await net.add('owner','owner');
    const id = await n.model.createTextNow('main.tex','saved project');
    let denied = true; const disk = new Map<string,Uint8Array>(); const notices: string[] = [];
    const fs: FsAdapter = { list: async () => { if(denied) throw new Error('scan denied'); return [...disk].map(([path,b]) => ({path,size:b.length})); },
      read:async (path) => disk.get(path) ?? null, write:async(path,b) => {disk.set(path,b);}, remove:async(path) => {disk.delete(path);}, watch:()=>()=>{} };
    expect(await scanFs(fs)).toMatchObject({complete:false});
    const mirror = new MirrorSync({model:n.model,mesh:n.mesh,blobs:new BlobManager(n.mesh,n.store),fs,getRole:()=>n.role,retryMs:10,onNotice:(m)=>notices.push(m)});
    mirrors.push(mirror); await mirror.start();
    expect(n.model.byId(id)).toBeDefined(); expect(disk.size).toBe(0);
    expect(notices.some((m)=>m.includes('scan denied'))).toBe(true);
    denied=false; await waitFor(()=>dec(disk.get('main.tex'))==='saved project');
    expect(notices.some((m)=>m.includes('access is ready'))).toBe(true);
  });
  it('retains the file and reports a temporary read error, then retries (audit F01)', async () => {
    const s = await setup();
    s.disk.set('main.tex', enc('new disk content'));
    s.fail(new Error('permission denied'));
    s.notify();
    await waitFor(() => s.notices.some((n) => n.includes('permission denied')));
    expect(s.n.model.byId(s.id)).toBeDefined();
    expect((await s.n.model.openText(s.id)).toString()).toBe('original');
    s.fail(null);
    await waitFor(async () => (await s.n.model.openText(s.id)).toString() === 'new disk content');
  });

  it('keeps unimported external bytes when a remote deletion beats the watcher (audit F02)', async () => {
    const s = await setup();
    s.disk.set('main.tex', enc('external unsynced contribution'));
    s.n.model.delete(s.id);
    await waitFor(() => s.notices.some((n) => n.includes('main.tex')));
    expect(dec(s.disk.get('main.tex'))).toBe('external unsynced contribution');
    const recovery = await s.mirror.recoveries();
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.path).toBe('main.tex');
    expect(dec(await s.mirror.recoveryBytes(recovery[0]?.id as string))).toBe('external unsynced contribution');
    expect(await s.n.store.listBlobs()).toEqual([]); // private recovery is never a shared blob
  });

  it('retains a viewer external edit privately before restoring the shared version', async () => {
    const s = await setup();
    s.n.role = 'viewer';
    s.disk.set('main.tex', enc('private viewer contribution')); s.notify();
    await waitFor(async () => (await s.mirror.recoveries()).some((r) => r.reason.includes('Read-only')));
    await waitFor(() => dec(s.disk.get('main.tex')) === 'original');
    expect((await s.n.model.openText(s.id)).toString()).toBe('original');
    const record = (await s.mirror.recoveries()).find((r) => r.reason.includes('Read-only'))!;
    expect(dec(await s.mirror.recoveryBytes(record.id))).toBe('private viewer contribution');
    expect(await s.n.store.listBlobs()).toEqual([]);
  });
});
