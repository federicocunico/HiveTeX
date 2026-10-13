import * as Y from 'yjs';
import type { EditIngress, IngressResult } from './ingress.js';
import type { ProjectModel } from './model.js';
import { MIRROR_ORIGIN } from './origins.js';

/**
 * Editor attachment to the authoritative runtime (D3, 7.1-7.2). The renderer keeps a transient replica of each open
 * document; the actor (runtime) stays the only network peer and persistence owner.
 *
 * Attaching: the renderer sends its state vector; the actor answers with the missing update and the document's current
 * revision, and from then on streams deltas tagged with increasing revisions. Deltas that arrive before the snapshot
 * are buffered and applied after it only if their revision is newer (the revision barrier), so nothing is lost or
 * applied twice across an attachment or a renderer reload. Local edits go to the actor with the attachment id and a
 * sequence number through the edit ingress (journal, authorization, durability); the actor never echoes an
 * attachment's own edits back to it.
 */

export const BRIDGE_ORIGIN = Symbol('editor-bridge');

export interface Snapshot {
  docId: string;
  update: Uint8Array;
  revision: number;
}
export interface Delta {
  docId: string;
  update: Uint8Array;
  revision: number;
}

/** Actor side: serves attachments of one runtime's documents. */
export class ActorDocs {
  private revisions = new Map<string, number>();
  private subs = new Map<string, Map<string, (d: Delta) => void>>();
  private unsub: () => void;
  private closed = false;
  private attachmentGenerations = new Map<string,number>();
  private detached = new Set<string>();

  constructor(
    private o: { model: ProjectModel; ingress: EditIngress },
  ) {
    // Every applied change of a document, whoever made it, becomes the next revision for its attachments.
    this.unsub = o.model.onDocUpdate((docId, update, origin) => {
      const rev = (this.revisions.get(docId) ?? 0) + 1;
      this.revisions.set(docId, rev);
      const from = (origin as { attachment?: string } | null)?.attachment;
      for (const [att, cb] of this.subs.get(docId) ?? []) if (att !== from) cb({ docId, update, revision: rev });
    });
  }

  revision(docId: string) {
    return this.revisions.get(docId) ?? 0;
  }

  /** Answers an attachment: the update the renderer lacks and the revision it corresponds to; then streams deltas. */
  async attach(attachment: string, docId: string, stateVector: Uint8Array, onDelta: (d: Delta) => void): Promise<Snapshot> {
    if(this.closed || this.detached.has(attachment))throw new Error('attachment closed');
    const key=JSON.stringify([attachment,docId]);
    const generation=(this.attachmentGenerations.get(key)??0)+1;
    this.attachmentGenerations.set(key,generation);
    const doc = await this.o.model.getDoc(docId);
    if(this.closed || this.detached.has(attachment) || this.attachmentGenerations.get(key)!==generation)throw new Error('attachment closed');
    const s = this.subs.get(docId) ?? new Map();
    s.set(attachment, onDelta);
    this.subs.set(docId, s);
    // Synchronous with respect to onDocUpdate: the snapshot is exactly the state at `revision`.
    return { docId, update: Y.encodeStateAsUpdate(doc, stateVector), revision: this.revision(docId) };
  }

  detach(attachment: string, docId?: string) {
    if(docId){const key=JSON.stringify([attachment,docId]);this.attachmentGenerations.set(key,(this.attachmentGenerations.get(key)??0)+1);}
    else this.detached.add(attachment);
    for (const [d, s] of this.subs) if (!docId || d === docId) s.delete(attachment);
  }

  /** A renderer edit: journaled, authorized, applied once with the attachment as origin, then durable. */
  submit(attachment: string, seq: number, docId: string, update: Uint8Array, source?: 'editor'|'folder'): Promise<IngressResult> {
    return this.o.ingress.submit({ attachment, seq, docId, update, ...(source?{source}:{}) });
  }

  close() {
    this.closed = true;
    this.unsub();
    this.subs.clear();
  }
}

/** The transport between renderer and actor (IPC in the app, direct calls in tests). */
export interface ActorLink {
  attach(attachment: string, docId: string, stateVector: Uint8Array, onDelta: (d: Delta) => void): Promise<Snapshot>;
  detach(attachment: string, docId: string): void;
  submit(attachment: string, seq: number, docId: string, update: Uint8Array): Promise<IngressResult>;
}

export type EditState = 'saved' | 'pending' | 'denied' | 'error';

/** Renderer side: one transient replica per open document, attached to the actor. */
export class RendererDoc {
  readonly doc = new Y.Doc();
  private applied = 0;
  private attached = false;
  private buffer: Delta[] = [];
  private seq = 0;
  private inFlight = new Set<number>();
  private stateCbs = new Set<(s: EditState) => void>();
  state: EditState = 'saved';

  constructor(
    private link: ActorLink,
    readonly attachment: string,
    readonly docId: string,
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === BRIDGE_ORIGIN) return; // a change that came from the actor
      void this.sendLocal(update);
    });
  }

  onState(cb: (s: EditState) => void) {
    this.stateCbs.add(cb);
    return () => void this.stateCbs.delete(cb);
  }
  private setState(s: EditState) {
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  /** Attaches (again after a renderer reload): only what this replica lacks is sent, then deltas in revision order. */
  async attach(): Promise<void> {
    this.attached = false;
    this.buffer = [];
    const snap = await this.link.attach(this.attachment, this.docId, Y.encodeStateVector(this.doc), (d) => this.onDelta(d));
    Y.applyUpdate(this.doc, snap.update, BRIDGE_ORIGIN);
    this.applied = snap.revision;
    // The revision barrier: deltas buffered meanwhile are applied only if newer than the snapshot.
    const buffered = this.buffer.sort((a, b) => a.revision - b.revision);
    this.buffer = [];
    this.attached = true;
    for (const d of buffered) this.onDelta(d);
  }

  private onDelta(d: Delta) {
    if (!this.attached) {
      this.buffer.push(d);
      return;
    }
    if (d.revision <= this.applied) return; // already part of the snapshot
    Y.applyUpdate(this.doc, d.update, BRIDGE_ORIGIN);
    this.applied = d.revision;
  }

  private async sendLocal(update: Uint8Array) {
    const seq = ++this.seq;
    this.inFlight.add(seq);
    this.setState('pending');
    try {
      const r = await this.link.submit(this.attachment, seq, this.docId, update);
      this.inFlight.delete(seq);
      if (r.status === 'denied') this.setState('denied');
      else if (this.inFlight.size === 0 && this.state !== 'denied') this.setState('saved');
    } catch {
      this.inFlight.delete(seq);
      this.setState('error'); // the edit stays in this replica and journal; never shown as saved
    }
  }

  detach() {
    this.link.detach(this.attachment, this.docId);
    this.attached = false;
  }
}

/** An in-process link (tests; the worker's IPC adapter implements the same calls). */
export function directLink(actor: ActorDocs, latencyMs = 0): ActorLink {
  const later = <T>(f: () => T | Promise<T>) => new Promise<T>((r, j) => setTimeout(() => Promise.resolve().then(f).then(r, j), latencyMs));
  return {
    attach: (a, d, sv, cb) => later(() => actor.attach(a, d, sv, (x) => setTimeout(() => cb(x), latencyMs))),
    detach: (a, d) => actor.detach(a, d),
    submit: (a, s, d, u) => later(() => actor.submit(a, s, d, u)),
  };
}

/** Typed project commands from an attached editor (7.2): never whole-snapshot replacements. */
export type ActorCommand =
  | { kind: 'create'; path: string; text?: string; source?:'folder' }
  | { kind: 'rename'; id: string; path: string }
  | { kind: 'delete'; id: string }
  | { kind: 'batch'; ops: import('./model.js').BatchOp[] }
  | { kind: 'undo'; changeSetId: string }
  | { kind: 'restore'; snapshotId: string };

export type CommandResult = { ok: true; value?: unknown } | { ok: false; reason: 'denied' | 'not-found' | 'error'; message?: string };

/**
 * Executes editor commands on the authoritative replica with the current authorization, and resolves only once the
 * result is durable. A command refused by the current role changes nothing.
 */
export class ActorCommands {
  constructor(
    private o: { model: ProjectModel; changelog?: import('./changelog.js').ChangeLog; canApply: () => boolean },
  ) {}

  async run(c: ActorCommand): Promise<CommandResult> {
    if (!this.o.canApply()) return { ok: false, reason: 'denied' };
    const m = this.o.model;
    try {
      let value: unknown;
      switch (c.kind) {
        case 'create':
          value = await m.createTextNow(c.path, c.text ?? '', c.source==='folder'?MIRROR_ORIGIN:undefined, this.o.canApply);
          break;
        case 'rename':
          if (!m.byId(c.id)) return { ok: false, reason: 'not-found' };
          m.rename(c.id, c.path);
          break;
        case 'delete':
          if (!m.byId(c.id)) return { ok: false, reason: 'not-found' };
          m.delete(c.id);
          break;
        case 'batch':
          value = Object.fromEntries((await m.applyBatch(c.ops, this.o.canApply)).created);
          break;
        case 'undo': {
          const set = (await this.o.changelog?.list())?.find((s) => s.id === c.changeSetId);
          if (!set || !this.o.changelog) return { ok: false, reason: 'not-found' };
          if (!this.o.canApply()) return { ok: false, reason: 'denied' };
          value = (await this.o.changelog.undo(set, this.o.canApply))?.id ?? null;
          break;
        }
        case 'restore':
          value = await m.restore(c.snapshotId, this.o.canApply);
          break;
        default:
          return { ok: false, reason: 'error', message: 'Unknown project command' };
      }
      await m.flush();
      return { ok: true, ...(value === undefined ? {} : { value }) };
    } catch (e) {
      if (!this.o.canApply()) return { ok: false, reason: 'denied' };
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * Offline-merge conflicts as seen by an attached editor (7.3). Every conflict carries a revision: a hash of exactly
 * what the member was shown. A resolution for an older revision (a reloaded renderer, a conflict that changed meanwhile
 * or was already resolved elsewhere) is refused as stale instead of publishing obsolete work; the fork itself refuses
 * members who lost edit rights. Resolutions are serialized.
 */
export class ActorConflicts {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private o: { fork: import('./fork.js').OfflineFork; canApply: () => boolean }) {}

  static revision(c: import('./fork.js').MergeConflict): string {
    const s = JSON.stringify(c);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return `${s.length.toString(36)}-${h.toString(36)}`;
  }

  list() {
    return this.o.fork.conflicts.map((c) => ({ ...c, rev: ActorConflicts.revision(c) }));
  }

  private current(id: string, rev: string) {
    const c = this.o.fork.conflicts.find((x) => x.id === id);
    if (!c) return 'not-found' as const;
    return ActorConflicts.revision(c) === rev ? c : ('stale' as const);
  }

  resolveText(id: string, rev: string, decisions: Array<import('./merge.js').HunkDecision | undefined>) {
    return this.serial(async () => {
      if (!this.o.canApply()) return 'denied' as const;
      const c = this.current(id, rev);
      if (typeof c === 'string') return c;
      return this.o.fork.resolveText(id, decisions);
    });
  }

  resolveFile(id: string, rev: string, choice: import('./fork.js').FileChoice) {
    return this.serial(async () => {
      if (!this.o.canApply()) return 'denied' as const;
      const c = this.current(id, rev);
      if (typeof c === 'string') return c;
      await this.o.fork.resolveFile(id, choice);
      return 'resolved' as const;
    });
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f);
    this.chain = run.catch(() => {});
    return run;
  }
}
