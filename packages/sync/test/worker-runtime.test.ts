import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys } from "@hivetex/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcEndpoint } from "../src/worker-ipc.js";
import { WorkerRenderer } from "../src/worker/renderer.js";
import { encodeValue, decodeValue } from "../src/native-persistence.js";
import { fakeNative } from "./native-fake.js";
import { sha256Hex } from '../src/model.js';
import { emptySeedData, type SeedData } from '../src/worker/catalog.js';

describe("live packaged worker and editor replica", () => {
  let bundle: string, secret: string;
  const children: ChildProcessWithoutNullStreams[] = [];
  beforeAll(async () => {
    // @ts-expect-error build script is a plain ES module
    const { buildWorker } = await import("../../../apps/desktop/worker-build.mjs");
    bundle = await buildWorker(join(mkdtempSync(join(tmpdir(), "hivetex-actor-")), "worker.mjs"));
    const keys = await generateDeviceKeys({ forceNoble: true });
    if (keys.kind !== "noble") throw new Error("raw seed fixture required");
    secret = JSON.stringify({
      ...keys,
      edSeed: Buffer.from(keys.edSeed).toString("base64"),
      xSeed: Buffer.from(keys.xSeed).toString("base64"),
      deviceId: "device-1",
    });
  });
  afterAll(() => {
    for (const c of children) c.kill();
  });
  function start(native = fakeNative(), heldJournal = false, credentials: 'normal' | 'no-key' | 'no-token' | 'locked' = 'normal') {
    const child = spawn(process.execPath, [bundle], {
      stdio: "pipe",
      env: { HIVETEX_WORKER_GEN: "1" },
    });
    children.push(child);
    const rpc = new RpcEndpoint({ gen: 1, write: (frame) => child.stdin.write(frame) });
    child.stdout.on("data", (chunk) => rpc.receive(new Uint8Array(chunk)));
    const calls: string[] = [];
    const secretKeys: string[] = [];
    const handles:number[]=[];
    let custodied = false;
    let catalog: SeedData = emptySeedData();
    rpc.handle("native.call", async (wire) => {
      const p = wire as { cmd: string; args: Record<string, unknown> };
      calls.push(p.cmd);
      if (p.cmd === 'catalog_load') return structuredClone(catalog);
      if (p.cmd === 'catalog_save') { catalog = structuredClone(p.args.value as SeedData); return null; }
      if (p.cmd === "secret_get") {
        secretKeys.push(p.args.key as string);
        if (credentials === 'locked') throw new Error('OS keychain locked');
        if (String(p.args.key).startsWith('session-token:')) return p.args.key === 'session-token:http://localhost:3000' && credentials !== 'no-token' ? 'session' : null;
        return String(p.args.key).startsWith('device:') && credentials !== 'no-key' ? secret : null;
      }
      if (p.cmd.startsWith("attachment_")) return null;
      const result=await native.invoke(p.cmd, p.args);
      if(p.cmd==='store_open')handles.push(result as number);
      if(p.cmd==='store_ingress_put' && heldJournal){custodied=true;return new Promise(()=>{});}
      return result;
    });
    const link = {
      request: async <T>(method: string, p: unknown) =>
        decodeValue(await rpc.request<string>(method, encodeValue(p))) as T,
      on: (event: string, cb: (p: any) => void) =>
        rpc.on(event, (p) => cb(decodeValue(p as string))),
    };
    return { child, rpc, link, native, calls, secretKeys, handles, get custodied(){return custodied;} };
  }
  it('uses only origin-scoped credentials and never falls back to the old global token', async () => {
    const w = start();
    await w.link.request('catalog.activate', { server: 'http://localhost:3000', account: 'user' });
    expect(w.secretKeys).toContain('session-token:http://localhost:3000');
    await w.link.request('account.stop', {});
    const server = 'https://b.example';
    await w.link.request('catalog.activate', { server, account: 'user' });
    const { storeScope } = await import('../src/native-persistence.js');
    const editor = new WorkerRenderer(w.link);
    await expect(editor.open({ server, account: 'user', project: 'shared-1', scope: await storeScope(server, 'user', 'shared-1'), isLocal: false, createdHere: false, role: 'editor' })).rejects.toThrow('Sign in');
    expect(w.secretKeys).toContain('session-token:https://b.example');
    expect(w.secretKeys).not.toContain('session-token');
    expect(w.calls).not.toContain('store_open');
    w.child.stdin.end();
  });
  it('accepts a current-run session without retaining its active profile or token in the catalog', async () => {
    const w = start(fakeNative(), false, 'no-token');
    await w.link.request('catalog.activate', { server: 'http://localhost:3000', account: 'user', session: { token: 'live-only', remembered: false } });
    expect(w.secretKeys.some((key) => key.startsWith('session-token'))).toBe(false);
    await w.link.request('account.stop', {});
    await w.link.request('catalog.activate', { server: 'http://localhost:3000', account: 'user' });
    expect(w.secretKeys).toContain('session-token:http://localhost:3000');
    w.child.stdin.end();
  });

  const project = (id = "local-p1", role: "editor" | "viewer" = "editor") => ({
    server: "http://localhost:3000",
    account: "user",
    project: id,
    scope: "local-" + id,
    isLocal: true,
    createdHere: true,
    role,
  });
  it("hosts two scoped projects without a DOM, persists bridged typing, and reattaches to the same actor", async () => {
    const w = start(),
      a = new WorkerRenderer(w.link),
      b = new WorkerRenderer(w.link);
    await a.open(project());
    await b.open(project("local-p2"));
    const id = await a.model.createTextNow("main.tex", "hello");
    const text = await a.model.openText(id);
    text.insert(text.length, " world");
    await a.model.flush();
    expect(w.calls).toContain("store_ingress_put");
    expect(w.calls).toContain("store_ingress_ack");
    const again = new WorkerRenderer(w.link);
    await again.open(project());
    expect((await again.model.openText(id)).toString()).toBe("hello world");
    expect(b.model.list()).toHaveLength(0);
    await a.close();
    (await again.model.openText(id)).insert(0, "kept ");
    await again.model.flush();
    expect((await again.model.openText(id)).toString()).toBe("kept hello world");
    await again.close();
    await b.close();
    w.child.stdin.end();
  });
  it("denies viewer commands, rejects account substitution, and cannot dispatch generic filesystem requests", async () => {
    const w = start(),
      view = new WorkerRenderer(w.link);
    await view.open(project("local-read", "viewer"));
    await expect(view.model.createTextNow("bad.tex", "forbidden")).rejects.toThrow("denied");
    const other = new WorkerRenderer(w.link);
    await expect(other.open({ ...project("local-other"), account: "another" })).rejects.toThrow(
      "barrier",
    );
    await expect(w.link.request("fs.read", {})).rejects.toThrow("unknown method");
    expect(view.model.list()).toHaveLength(0);
    await view.close();
    w.child.stdin.end();
  });
  it('streams an asset larger than the IPC ceiling through native staging and reads bounded ranges', async () => {
    const w = start(), editor = new WorkerRenderer(w.link);
    await editor.open(project('local-large-asset'));
    const bytes = new Uint8Array(9 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const hash = await editor.blobs.add(bytes);
    expect(hash).toBe(await sha256Hex(bytes));
    expect(await editor.blobs.has(hash)).toBe(true);
    expect(await editor.blobs.held()).toEqual(new Set([hash]));
    expect(w.calls.filter((c) => c === 'store_stage_chunk')).toHaveLength(10);
    expect(w.calls.filter((c) => c === 'store_stage_commit')).toHaveLength(1);
    const received = await editor.blobs.get(hash);
    expect(received?.length).toBe(bytes.length);
    expect(await sha256Hex(received!)).toBe(hash);
    expect(w.calls.filter((c) => c === 'store_read_blob')).toHaveLength(10);
    await editor.close(); w.child.stdin.end();
  }, 90_000);
  it('rejects cross-attachment, out-of-order and partial uploads; account freeze aborts unpublished staging', async () => {
    const w = start(), one = new WorkerRenderer(w.link), two = new WorkerRenderer(w.link);
    await one.open(project('local-staging')); await two.open(project('local-staging'));
    const bytes = new Uint8Array([1, 2, 3]), hash = await sha256Hex(bytes);
    const request = (method: string, attachment: string, data: object) => w.link.request(method, { attachment, ...data });
    const upload = await request('blob.begin', one.attachment, { hash, size: bytes.length });
    await expect(request('blob.chunk', two.attachment, { upload, part: 0, bytes })).rejects.toThrow('invalid upload');
    await expect(request('blob.chunk', one.attachment, { upload, part: 1, bytes })).rejects.toThrow('invalid blob chunk');
    await expect(request('blob.commit', one.attachment, { upload })).rejects.toThrow('incomplete blob');
    await request('blob.chunk', one.attachment, { upload, part: 0, bytes });
    expect(await one.blobs.has(hash)).toBe(false);
    await w.link.request('account.freeze', {});
    await expect(request('blob.commit', one.attachment, { upload })).rejects.toThrow();
    expect(await one.blobs.has(hash)).toBe(false);
    await one.close(); await two.close(); w.child.stdin.end();
  });
  it('compensates a native chunk completed after account freeze and rejects a forged content hash', async () => {
    const native = fakeNative(), original = native.invoke;
    let release!: () => void, staged = false;
    const held = new Promise<void>((r) => { release = r; });
    native.invoke = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await original<T>(cmd, args);
      if (cmd === 'store_stage_chunk') { staged = true; await held; }
      return result;
    };
    const w = start(native), editor = new WorkerRenderer(w.link);
    await editor.open(project('local-late-staging'));
    const bytes = new Uint8Array([1, 2, 3]), hash = await sha256Hex(bytes);
    const request = (method: string, data: object) => w.link.request(method, { attachment: editor.attachment, ...data });
    const upload = await request('blob.begin', { hash, size: 3 });
    const chunk = request('blob.chunk', { upload, part: 0, bytes });
    await expect.poll(() => staged).toBe(true);
    await w.link.request('account.freeze', {});
    release();
    await expect(chunk).rejects.toThrow('denied');
    expect(await editor.blobs.has(hash)).toBe(false);
    await editor.close(); w.child.stdin.end();

    const next = start(), other = new WorkerRenderer(next.link);
    await other.open(project('local-forged-staging'));
    const badUpload = await next.link.request('blob.begin', { attachment: other.attachment, hash, size: 3 });
    await next.link.request('blob.chunk', { attachment: other.attachment, upload: badUpload, part: 0, bytes: new Uint8Array([4, 5, 6]) });
    await expect(next.link.request('blob.commit', { attachment: other.attachment, upload: badUpload })).rejects.toThrow();
    expect(await other.blobs.has(hash)).toBe(false);
    await other.close(); next.child.stdin.end();
  });
  it('streams a journal above the IPC ceiling and exports denied edits after renderer recreation', async () => {
    const native = fakeNative();
    const p = project('local-big-journal');
    const handle = await native.invoke<number>('store_open', { scope: p.scope });
    const b64 = Buffer.alloc(1024 * 1024, 7).toString('base64');
    for (let seq = 1; seq <= 12; seq++) {
      await native.invoke('store_ingress_put', { id: handle, attachment: 'old-editor', seq, doc: 'f:denied', b64, source: 'folder' });
      await native.invoke('store_ingress_deny', { id: handle, attachment: 'old-editor', seq });
    }
    await native.invoke('store_close', { id: handle });
    const w = start(native), editor = new WorkerRenderer(w.link);
    await editor.open(p);
    expect(editor.model.list()).toEqual([]); // denied bytes are recovery data, never applied/published
    expect(w.calls.filter((c) => c === 'store_ingress_page')).toHaveLength(5);
    expect(w.calls).not.toContain('store_ingress_pending');
    const exported = await editor.recoveryEntries();
    expect(exported.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(exported.every((e) => e.denied && e.source === 'folder' && e.update.length === 1024 * 1024)).toBe(true);
    await editor.close();
    const recreated = new WorkerRenderer(w.link);
    await recreated.open(p);
    expect((await recreated.recoveryEntries()).length).toBe(12);
    expect(recreated.model.list()).toEqual([]);
    await recreated.close(); w.child.stdin.end();
  }, 90_000);
  it('recovers an edit after the actual worker dies between custody and application, without duplication',async()=>{
    const native=fakeNative();
    const first=start(native,true),editor=new WorkerRenderer(first.link);
    await editor.open(project('local-crash'));
    const id=await editor.model.createTextNow('main.tex','base');
    (await editor.model.openText(id)).insert(4,' recovered');
    await expect.poll(()=>first.custodied).toBe(true);
    first.child.kill();first.rpc.close();
    for(const id of first.handles)await native.invoke('store_close',{id});
    const next=start(native),reopened=new WorkerRenderer(next.link);
    await reopened.open(project('local-crash'));
    expect((await reopened.model.openText(id)).toString()).toBe('base recovered');
    const again=new WorkerRenderer(next.link);await again.open(project('local-crash'));
    expect((await again.model.openText(id)).toString()).toBe('base recovered');
    await reopened.close();await again.close();next.child.stdin.end();
  });
  it('freezes networking/new attachments before flushing existing local input, and local mode can then reopen', async () => {
    const w = start(), editor = new WorkerRenderer(w.link);
    await editor.open(project());
    const id = await editor.model.createTextNow('main.tex', 'base');
    await w.link.request('account.freeze', {});
    const stale = new WorkerRenderer(w.link);
    await expect(stale.open(project('local-stale'))).rejects.toThrow('stopped');
    (await editor.model.openText(id)).insert(4, ' durable during stop');
    await editor.model.flush();
    await editor.close(); await w.link.request('account.stop', {});
    await w.link.request('catalog.activate', { server: 'http://localhost:3000', account: 'local' });
    const local = new WorkerRenderer(w.link);
    await local.open({ ...project(), account: 'local' });
    expect((await local.model.openText(id)).toString()).toBe('base durable during stop');
    await local.close(); w.child.stdin.end();
  });
  it('missing or locked OS identity never creates a temporary worker key or opens a project store', async () => {
    for (const mode of ['no-key', 'locked'] as const) {
      const w = start(fakeNative(), false, mode), editor = new WorkerRenderer(w.link);
      await expect(editor.open(project())).rejects.toThrow(/credentials|keychain/);
      expect(w.calls).not.toContain('secret_set'); expect(w.calls).not.toContain('store_open');
      w.child.stdin.end();
    }
  });
});
