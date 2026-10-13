import { createHash } from 'node:crypto';
import { NATIVE_CHUNK, type StoreInvoke } from '../src/native-persistence.js';

/** A stand-in for the desktop's store commands (store_cmd.rs), keyed by scope like the real files. */
export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export function fakeNative() {
  const calls: string[] = [];
  const open = new Set<string>();
  let failNextTransact = false;
  type Data = { docs: Map<string, string[]>; meta: Map<string, string>; blobs: Map<string, Uint8Array>; staging: Map<string, { hash: string; size: number; parts: Map<number, Uint8Array> }>; snaps: Map<string, { at: number; v: string }>; changes: Map<string, { at: number; v: string }>; ingress: Map<string, { attachment: string; seq: number; doc: string; b64: string; source?: string; denied?: boolean }> };
  const byScope = new Map<string, Data>();
  const stores = new Map<number, Data>();
  const scopeOf = new Map<number, string>();
  let next = 0;
  const invoke: StoreInvoke = async <T>(cmd: string, a: Record<string, unknown> = {}): Promise<T> => {
    calls.push(cmd);
    if (cmd === 'store_open') {
      const scope = a.scope as string;
      if (open.has(scope)) throw new Error('store already open');
      open.add(scope);
      const data = byScope.get(scope) ?? { docs: new Map(), meta: new Map(), blobs: new Map(), staging: new Map(), snaps: new Map(), changes: new Map(), ingress: new Map() };
      byScope.set(scope, data);
      stores.set(++next, data);
      scopeOf.set(next, scope);
      return next as T;
    }
    const s = stores.get(a.id as number);
    if (!s) throw new Error('unknown store handle');
    switch (cmd) {
      case 'store_transact': {
        if (failNextTransact) { failNextTransact = false; throw new Error('disk full'); }
        const docs = new Map([...s.docs].map(([k, v]) => [k, [...v]]));
        const meta = new Map(s.meta);
        for (const o of a.ops as Array<{ op: string; doc: string; updates: string[]; state: string; key: string; value: string | null }>) {
          if (o.op === 'append') docs.set(o.doc, [...(docs.get(o.doc) ?? []), ...o.updates]);
          else if (o.op === 'compact') docs.set(o.doc, [o.state]);
          else if (o.value === null) meta.delete(o.key);
          else meta.set(o.key, o.value);
        }
        s.docs = docs; s.meta = meta;
        return undefined as T;
      }
      case 'store_load': return [...(s.docs.get(a.doc as string) ?? [])] as T;
      case 'store_list_docs': return [...s.docs.keys()].sort() as T;
      case 'store_put_blob': {
        const bytes = unb64(a.b64 as string);
        if (bytes.length > NATIVE_CHUNK) throw new Error('blob too large for one call');
        if (sha(bytes) !== a.hash) throw new Error('blob content does not match its hash');
        s.blobs.set(a.hash as string, bytes);
        return undefined as T;
      }
      case 'store_stage_chunk': {
        const st = s.staging.get(a.upload as string) ?? { hash: a.hash as string, size: a.size as number, parts: new Map() };
        st.parts.set(a.part as number, unb64(a.b64 as string));
        s.staging.set(a.upload as string, st);
        return undefined as T;
      }
      case 'store_stage_commit': {
        const st = s.staging.get(a.upload as string);
        s.staging.delete(a.upload as string);
        if (!st) throw new Error('nothing staged');
        const parts = [...st.parts.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        if (all.length !== st.size || sha(all) !== st.hash) throw new Error('staged blob rejected');
        s.blobs.set(st.hash, all);
        return undefined as T;
      }
      case 'store_stage_abort': s.staging.delete(a.upload as string); return undefined as T;
      case 'store_blob_size': return (s.blobs.get(a.hash as string)?.length ?? null) as T;
      case 'store_read_blob': {
        const b = s.blobs.get(a.hash as string);
        return (b ? b64(b.subarray(a.offset as number, (a.offset as number) + (a.len as number))) : null) as T;
      }
      case 'store_list_blobs': return [...s.blobs.keys()].sort() as T;
      case 'store_put_snapshot': s.snaps.set(a.sid as string, { at: a.at as number, v: a.value as string }); return undefined as T;
      case 'store_list_snapshots': return [...s.snaps.values()].sort((x, y) => x.at - y.at).map((x) => x.v) as T;
      case 'store_get_meta': return (s.meta.get(a.key as string) ?? null) as T;
      case 'store_put_change': s.changes.set(a.cid as string, { at: a.endedAt as number, v: a.value as string }); return undefined as T;
      case 'store_list_changes': return [...s.changes.values()].sort((x, y) => y.at - x.at).map((x) => x.v) as T;
      case 'store_prune_changes': {
        const sorted = [...s.changes.entries()].sort((x, y) => y[1].at - x[1].at);
        let n = 0;
        sorted.forEach(([id, c], i) => { if (!(i < 500 || (a.now as number) - c.at <= 7 * 24 * 3600 * 1000)) { s.changes.delete(id); n++; } });
        return n as T;
      }
      case 'store_close': open.delete(scopeOf.get(a.id as number) ?? ''); stores.delete(a.id as number); return undefined as T;
      case 'store_list_meta': return [...s.meta.keys()].sort() as T;
      case 'store_ingress_put': { const k = `${a.attachment}\0${String(a.seq).padStart(16, '0')}`; if (!s.ingress.has(k)) s.ingress.set(k, { attachment: a.attachment as string, seq: a.seq as number, doc: a.doc as string, b64: a.b64 as string, source: a.source as string }); return undefined as T; }
      case 'store_ingress_ack': for (const [k, e] of s.ingress) if (e.attachment === a.attachment && e.seq <= (a.seq as number) && !e.denied) s.ingress.delete(k); return undefined as T;
      case 'store_ingress_get': return [...s.ingress.values()].find(e=>e.attachment===a.attachment && e.seq===a.seq) as T;
      case 'store_ingress_deny': for(const e of s.ingress.values())if(e.attachment===a.attachment && e.seq===a.seq)e.denied=true;return undefined as T;
      case 'store_ingress_pending': return [...s.ingress.keys()].sort().map((k) => s.ingress.get(k)) as T;
      case 'store_ingress_page': {
        const rows = [...s.ingress.keys()].sort().map((k) => s.ingress.get(k)!)
          .filter((r) => r.attachment > String(a.afterAttachment ?? '') || (r.attachment === a.afterAttachment && r.seq > Number(a.afterSeq ?? 0)));
        const page: typeof rows = []; let bytes = 0;
        for (const row of rows) {
          const size = Math.floor(row.b64.length * 3 / 4) - (row.b64.endsWith('==') ? 2 : row.b64.endsWith('=') ? 1 : 0);
          if (page.length && (page.length >= 64 || bytes + size > 3 * 1024 * 1024)) break;
          bytes += size; page.push(row);
        }
        return page as T;
      }
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return { invoke, calls, failNext: () => { failNextTransact = true; } };
}

