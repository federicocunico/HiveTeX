import * as Y from 'yjs';
import type { ProjectModel } from './model.js';
import type { StoreInvoke } from './native-persistence.js';

/**
 * Editor edits on their way into the authoritative runtime (D3). A batch is journaled before its custody is
 * acknowledged, applied once, and acknowledged as durable only after the replica persisted it; the journal entry is
 * then dropped. After a crash anywhere in between, `recover()` replays what is still journaled: Yjs updates are
 * idempotent, so a replay of something already applied changes nothing, and nothing acknowledged is ever lost.
 */

export interface IngressEntry {
  attachment: string;
  seq: number;
  docId: string;
  update: Uint8Array;
  source?: 'editor' | 'folder';
  denied?: boolean;
}

/** Durable storage of not-yet-durable edits (the native store in the desktop app, memory in tests). */
export interface IngressJournal {
  /** Idempotent on (attachment, seq). Resolves once the entry is durable. */
  put(e: IngressEntry): Promise<void>;
  /** Drops every entry of the attachment up to and including `seq`. */
  ack(attachment: string, seq: number): Promise<void>;
  /** Everything still journaled, in (attachment, seq) order. */
  pending(): Promise<IngressEntry[]>;
  /** Native journals stream bounded pages during recovery instead of sending the entire journal in one frame. */
  pages?(): AsyncIterable<IngressEntry[]>;
  page?(after: { attachment: string; seq: number }): Promise<IngressEntry[]>;
  deny?(attachment:string,seq:number):Promise<void>;
  get?(attachment:string,seq:number):Promise<IngressEntry|undefined>;
}

export class MemoryIngressJournal implements IngressJournal {
  entries = new Map<string, IngressEntry>();
  async put(e: IngressEntry) {
    const k = `${e.attachment}\0${String(e.seq).padStart(16, '0')}`;
    if (!this.entries.has(k)) this.entries.set(k, { ...e, update: e.update.slice() });
  }
  async ack(attachment: string, seq: number) {
    for (const [k, e] of this.entries) if (e.attachment === attachment && e.seq <= seq && !e.denied) this.entries.delete(k);
  }
  async pending() {
    return [...this.entries.keys()].sort().map((k) => this.entries.get(k) as IngressEntry);
  }
  async deny(attachment:string,seq:number){for(const e of this.entries.values())if(e.attachment===attachment && e.seq===seq)e.denied=true;}
  async get(attachment:string,seq:number){return [...this.entries.values()].find(e=>e.attachment===attachment && e.seq===seq);}
}

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The ingress table of a native project store (store.rs), addressed by its open handle. */
export class NativeIngressJournal implements IngressJournal {
  constructor(
    private invoke: StoreInvoke,
    private id: number,
  ) {}
  async put(e: IngressEntry) {
    await this.invoke('store_ingress_put', { id: this.id, attachment: e.attachment, seq: e.seq, doc: e.docId, b64: toB64(e.update), source: e.source ?? 'editor' });
  }
  async ack(attachment: string, seq: number) {
    await this.invoke('store_ingress_ack', { id: this.id, attachment, seq });
  }
  async pending() {
    const out: IngressEntry[] = [];
    for await (const page of this.pages()) out.push(...page);
    return out;
  }
  async *pages() {
    let afterAttachment = '', afterSeq = 0;
    for (;;) {
      const rows = await this.page({ attachment: afterAttachment, seq: afterSeq });
      if (!rows.length) return;
      yield rows;
      const last = rows[rows.length - 1]!;
      afterAttachment = last.attachment; afterSeq = last.seq;
    }
  }
  async page(after: { attachment: string; seq: number }): Promise<IngressEntry[]> {
    const rows = await this.invoke<Array<{ attachment: string; seq: number; doc: string; b64: string; source?: 'editor'|'folder'; denied?:boolean }>>('store_ingress_page', { id: this.id, afterAttachment: after.attachment, afterSeq: after.seq });
    return rows.map((r) => ({ attachment: r.attachment, seq: r.seq, docId: r.doc, update: Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0)), ...(r.source?{source:r.source}:{}), ...(r.denied?{denied:true}:{}) }));
  }
  async deny(attachment:string,seq:number){await this.invoke('store_ingress_deny',{id:this.id,attachment,seq});}
  async get(attachment:string,seq:number){
    const row=await this.invoke<{attachment:string;seq:number;doc:string;b64:string;source?:'editor'|'folder';denied?:boolean}|null>('store_ingress_get',{id:this.id,attachment,seq});
    return row?{attachment:row.attachment,seq:row.seq,docId:row.doc,update:Uint8Array.from(atob(row.b64),c=>c.charCodeAt(0)),...(row.source?{source:row.source}:{}),...(row.denied?{denied:true}:{})}:undefined;
  }
}

export interface EditIngressOptions {
  journal: IngressJournal;
  model: ProjectModel;
  /** Current authorization of local edits (role, offline-fork policy). Denied edits stay journaled, never applied. */
  canApply: () => boolean;
  /** Transaction origin of applied edits (change log attribution, echo suppression). */
  origin?: unknown;
  /** Per-entry origin instead (the editor bridge tags edits with their attachment). */
  originFor?: (e: IngressEntry) => unknown;
}

export type IngressResult = { seq: number; status: 'durable' } | { seq: number; status: 'denied' };

export class EditIngress {
  /** Highest sequence applied per attachment in this process: a duplicate delivery is acknowledged, not re-applied. */
  private applied = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Edits refused by authorization, kept for export (never published). */
  readonly denied: IngressEntry[] = [];

  constructor(private o: EditIngressOptions) {}

  /**
   * One batch from an editor attachment. `onCustody` fires once the batch is journaled (the renderer may then stop
   * holding it); the promise resolves once it is durable in the replica, or reports it denied.
   */
  submit(e: IngressEntry, onCustody?: (seq: number) => void): Promise<IngressResult> {
    const run = this.chain.then(async (): Promise<IngressResult> => {
      await this.o.journal.put(e);
      onCustody?.(e.seq);
      const original=this.o.journal.get?await this.o.journal.get(e.attachment,e.seq):e;
      if(!original)throw new Error('Custodied edit is missing from its journal');
      return this.applyJournaled(original);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async applyJournaled(e: IngressEntry): Promise<IngressResult> {
    if (e.denied || this.denied.some(d=>d.attachment===e.attachment && d.seq===e.seq) || !this.o.canApply()) {
      await this.o.journal.deny?.(e.attachment,e.seq);
      if (!this.denied.some((d) => d.attachment === e.attachment && d.seq === e.seq)) this.denied.push(e);
      return { seq: e.seq, status: 'denied' };
    }
    if (e.seq > (this.applied.get(e.attachment) ?? -1)) {
      const doc = await this.o.model.getDoc(e.docId);
      const origin = this.o.originFor ? this.o.originFor(e) : this.o.origin;
      Y.applyUpdate(doc as Y.Doc, e.update, origin);
      this.applied.set(e.attachment, e.seq);
    }
    await this.o.model.flush();
    await this.o.journal.ack(e.attachment, e.seq);
    return { seq: e.seq, status: 'durable' };
  }

  /** After a restart: replays everything still journaled through the same authorization path, oldest first. */
  async recover(collect = true): Promise<IngressResult[]> {
    const run = this.chain.then(async () => {
      const out: IngressResult[] = [];
      const journal = this.o.journal;
      const pages = journal.pages?.() ?? (async function* () { yield await journal.pending(); })();
      for await (const page of pages) for (const e of page) {
        const result = await this.applyJournaled(e);
        if (collect) out.push(result);
      }
      return out;
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
