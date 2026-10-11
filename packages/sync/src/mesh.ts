import { type StoredDeviceKeys, verifyTicket } from '@hivetex/crypto';
import { MsgType, ROOT_DOC_ID, type TicketClaims, type TrustedKey } from '@hivetex/protocol';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { PeerConnection } from './connection.js';
import { jsonBytes, packDoc, parseJson, unpackDoc } from './frames.js';
import { LOCAL_ORIGIN, type ProjectModel } from './model.js';
import { DocPersister } from './persistence.js';
import type { PeerTransport } from './transport.js';

export interface MeshOptions {
  projectId: string;
  model: ProjectModel;
  keys: StoredDeviceKeys;
  trusted: TrustedKey[];
  getTicket: () => string;
  now?: () => Date;
  /** Seconds a peer with a stale epoch has to present a refreshed ticket. */
  epochGraceMs?: number;
  /** Minimum time between ticket refreshes provoked by unverified epoch hints (default 30 s). */
  epochHintRefreshMs?: number;
  policyIntervalMs?: number;
  /** A peer that sent nothing (not even pings) for this long is considered gone. Default 20 s. */
  deadAfterMs?: number;
  /**
   * Runs when a peer links, before any document is exchanged with it (the offline merge swaps in the last shared
   * state here, so offline edits are never sent as such: see fork.ts).
   */
  beforeSync?: (peer: PeerInfo) => Promise<void>;
}

export interface PeerInfo {
  deviceId: string;
  claims: TicketClaims;
  conn: PeerConnection;
  /** Latest raw ticket of the peer. */
  readonly ticket: string;
}

const MAX_UPDATE = 32 * 1024 * 1024;

type AppHandler = (from: PeerInfo, body: unknown) => void;
type RawHandler = (from: PeerInfo, payload: Uint8Array) => void;

/**
 * Connects the local project replica with every authenticated peer: Yjs sync (with per-document
 * interest so unopened files are not transferred), awareness, membership-epoch revocation and
 * extension points for blobs and application messages.
 */
export class Mesh {
  readonly awareness: Awareness;
  private conns = new Map<PeerConnection, PeerInfo>();
  private interest = new Map<PeerConnection, Set<string>>();
  private requested = new Map<PeerConnection, Set<string>>();
  private awarenessIds = new Map<PeerConnection, Set<number>>();
  private staleSince = new Map<PeerConnection, number>();
  /** Devices each peer says it is directly connected to (its 'nbrs' announcements). */
  private nbrs = new Map<PeerConnection, Set<string>>();
  private nbrsTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private appHandlers = new Map<string, Set<AppHandler>>();
  private rawHandlers = new Map<number, RawHandler>();
  private joinCbs = new Set<(p: PeerInfo) => void>();
  private docSyncedCbs = new Set<(docId: string, from: PeerInfo) => void>();
  private leaveCbs = new Set<(p: PeerInfo) => void>();
  private maxEpoch = 0;
  private maxEpochSince = 0;
  /** The verified ticket that proves `maxEpoch`; relayed so peers can verify the epoch themselves. */
  private epochEvidence: { raw: string; claims: TicketClaims } | null = null;
  private lastHintRefreshAt = 0;
  /** Newest verified (epoch, issued-at) seen per device in this session; survives connection replacement. */
  private deviceMarks = new Map<string, { ep: number; iat: number }>();
  private epochCbs = new Set<(epoch: number) => void>();
  private policyTimer: ReturnType<typeof setInterval>;
  /** Document frames wait for this (see MeshOptions.beforeSync). */
  private syncGate: Promise<void> = Promise.resolve();
  private unsub: () => void;
  readonly rejected: string[] = [];

  constructor(private o: MeshOptions) {
    this.awareness = new Awareness(o.model.root);
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin instanceof PeerConnection) {
        const set = this.awarenessIds.get(origin) ?? new Set<number>();
        for (const id of added) set.add(id);
        for (const id of removed) set.delete(id);
        this.awarenessIds.set(origin, set);
      }
      const changed = added.concat(updated, removed);
      const frame = encodeAwarenessUpdate(this.awareness, changed);
      const from = origin instanceof PeerConnection ? origin : undefined;
      for (const c of this.conns.keys()) if (this.shouldRelay(from, c)) void this.safeSend(c, MsgType.AWARENESS, frame);
    });
    this.onApp('nbrs', (from, body) => {
      const d = (body as { devices?: unknown })?.devices;
      if (Array.isArray(d)) this.nbrs.set(from.conn, new Set(d.filter((x): x is string => typeof x === 'string').slice(0, 1000)));
    });
    this.unsub = o.model.onDocUpdate((docId, update, origin) => this.onLocalDocUpdate(docId, update, origin));
    this.policyTimer = setInterval(() => {
      this.enforcePolicy();
      this.checkLiveness();
    }, o.policyIntervalMs ?? 5000);
    (this.policyTimer as unknown as { unref?: () => void }).unref?.();
  }

  private now() {
    return (this.o.now ?? (() => new Date()))().getTime();
  }

  get peers(): PeerInfo[] {
    return [...this.conns.values()];
  }
  get epoch() {
    return this.maxEpoch;
  }

  onPeerJoin(cb: (p: PeerInfo) => void) {
    this.joinCbs.add(cb);
  }
  onPeerLeave(cb: (p: PeerInfo) => void) {
    this.leaveCbs.add(cb);
  }
  /**
   * Fires when a newer membership epoch is verified, or a peer merely hints at one (time to refresh our ticket).
   * Hints never change policy and provoke at most one callback per `epochHintRefreshMs`.
   */
  onEpochAdvance(cb: (epoch: number) => void) {
    this.epochCbs.add(cb);
  }
  /** Fires when a peer's state for a document was applied (the document is now exchanged with that peer). */
  onDocSynced(cb: (docId: string, from: PeerInfo) => void) {
    this.docSyncedCbs.add(cb);
    return () => this.docSyncedCbs.delete(cb);
  }
  /**
   * `editorOnly` topics are privileged: the sender's role is checked when the message is dispatched (not when the
   * frame was decoded), so a demoted peer's message is never handed to the handler.
   */
  onApp(topic: string, h: AppHandler, opts: { editorOnly?: boolean } = {}) {
    const s = this.appHandlers.get(topic) ?? new Set();
    s.add(opts.editorOnly ? (from, body) => (from.claims.role === 'viewer' || from.conn.role === 'viewer' ? undefined : h(from, body)) : h);
    this.appHandlers.set(topic, s);
  }
  onRaw(type: number, h: RawHandler) {
    this.rawHandlers.set(type, h);
  }

  // ---- connections ----

  /** Wraps a transport in an authenticated connection and starts syncing once it is verified. */
  async addTransport(transport: PeerTransport): Promise<PeerInfo> {
    const conn = new PeerConnection({
      transport,
      projectId: this.o.projectId,
      keys: this.o.keys,
      trusted: this.o.trusted,
      getTicket: this.o.getTicket,
      ...(this.o.now ? { now: this.o.now } : {}),
    });
    let claims: TicketClaims;
    try {
      claims = await conn.ready;
    } catch (e) {
      this.rejected.push(e instanceof Error ? e.message : 'auth failed');
      throw e;
    }
    if (claims.dev === this.selfDevice()) {
      conn.close();
      throw new Error('connected to self');
    }
    // A device that already presented a newer ticket in this session cannot go back to an older one (an older
    // editor ticket would restore privileges the owner has since lowered), even on a fresh connection.
    const mark = this.deviceMarks.get(claims.dev);
    if (mark && (claims.ep < mark.ep || claims.iat < mark.iat)) {
      conn.close();
      this.rejected.push('stale device ticket');
      throw new Error('stale device ticket');
    }
    // A peer still presenting a ticket from before an epoch bump (someone was removed / demoted) is refused
    // once the grace period for refreshing has passed: otherwise a removed member could keep reconnecting.
    if (claims.ep < this.maxEpoch && this.now() - this.maxEpochSince > (this.o.epochGraceMs ?? 60_000)) {
      conn.close();
      this.rejected.push('stale membership epoch');
      throw new Error('stale membership epoch');
    }
    const info: PeerInfo = {
      deviceId: claims.dev,
      claims,
      conn,
      get ticket() {
        return conn.ticketRaw;
      },
    };
    // The same device reconnecting (page reloaded, app restarted) replaces its lingering old connection.
    for (const [old, oi] of this.conns) if (oi.deviceId === claims.dev) old.close();
    this.conns.set(conn, info);
    this.interest.set(conn, new Set());
    this.requested.set(conn, new Set());
    if (this.o.beforeSync) {
      const run = this.o.beforeSync;
      this.syncGate = this.syncGate.then(() => run(info)).catch(() => {});
    }
    conn.onFrame((c, type, payload) => void this.onFrame(c, type, payload));
    conn.onTicketRefreshed((c, nc) => this.onTicketRefreshed(c, nc));
    conn.onClose(() => this.dropConn(conn));
    this.noteDeviceTicket(claims);
    this.noteEpoch(claims, conn.ticketRaw);
    for (const cb of this.joinCbs) cb(info);
    this.announceNeighbours();
    await this.safeSend(conn, MsgType.EPOCH, this.epochFrame());
    await this.startSync(conn);
    return info;
  }

  private selfDevice() {
    try {
      const payload = JSON.parse(atob(this.o.getTicket().split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '')) as { dev?: string };
      return payload.dev;
    } catch {
      return undefined;
    }
  }

  private dropConn(conn: PeerConnection) {
    const info = this.conns.get(conn);
    this.conns.delete(conn);
    this.interest.delete(conn);
    this.requested.delete(conn);
    this.staleSince.delete(conn);
    this.nbrs.delete(conn);
    const ids = this.awarenessIds.get(conn);
    if (ids?.size) removeAwarenessStates(this.awareness, [...ids], conn);
    this.awarenessIds.delete(conn);
    if (info) for (const cb of this.leaveCbs) cb(info);
    if (info) {
      this.announceNeighbours();
      this.scheduleResync();
    }
  }

  /**
   * Relay rule: our own updates go to every peer; an update received from peer S is forwarded only to peers S is
   * not directly connected to (per S's latest 'nbrs' announcement). A full mesh therefore sends each edit exactly
   * once per connection, while devices that cannot connect directly still receive everything through the others.
   * If S's neighbours are unknown (old client, or not announced yet) we forward, which is always safe.
   */
  private shouldRelay(from: PeerConnection | undefined, to: PeerConnection) {
    if (!from) return true;
    if (to === from) return false;
    const known = this.nbrs.get(from);
    if (!known) return true;
    const target = this.conns.get(to)?.deviceId;
    return !(target && known.has(target));
  }

  /** Our peers that announced a direct link to `deviceId` (to route a message there through one hop). */
  peersLinkedTo(deviceId: string): string[] {
    const out: string[] = [];
    for (const [c, info] of this.conns) if (info.deviceId !== deviceId && this.nbrs.get(c)?.has(deviceId)) out.push(info.deviceId);
    return out;
  }

  /** Tells peers whom we are directly connected to (debounced: joins/leaves come in bursts). */
  private announceNeighbours() {
    if (this.nbrsTimer) return;
    this.nbrsTimer = setTimeout(() => {
      this.nbrsTimer = null;
      this.broadcastApp('nbrs', { devices: this.peers.map((p) => p.deviceId) });
    }, 50);
  }

  /**
   * After a link drops, neighbour lists are briefly stale and a relay might have been skipped: re-exchange state
   * vectors for the documents we sync, so any gap is filled from the remaining peers.
   */
  private scheduleResync() {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(async () => {
      this.resyncTimer = null;
      for (const [c, req] of this.requested) {
        for (const docId of req) {
          const doc = this.o.model.getLoadedDoc(docId);
          if (doc) await this.safeSend(c, MsgType.STEP1, packDoc(docId, Y.encodeStateVector(doc)));
        }
      }
    }, 300);
  }

  private async safeSend(conn: PeerConnection, type: number, payload: Uint8Array, noCompress = false) {
    try {
      await conn.send(type, payload, { noCompress });
    } catch {
      /* connection is going away */
    }
  }

  private async startSync(conn: PeerConnection) {
    await this.syncGate;
    const ids = await this.o.model.knownDocIds();
    // Root first, so the file table is current before file docs are reconciled.
    ids.sort((a, b) => (a === ROOT_DOC_ID ? -1 : b === ROOT_DOC_ID ? 1 : 0));
    for (const id of ids) await this.requestDoc(conn, id);
    await this.safeSend(conn, MsgType.AWARENESS, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
  }

  private async requestDoc(conn: PeerConnection, docId: string) {
    const req = this.requested.get(conn);
    if (!req || req.has(docId)) return;
    req.add(docId);
    const doc = await this.o.model.getDoc(docId);
    await this.safeSend(conn, MsgType.STEP1, packDoc(docId, Y.encodeStateVector(doc)));
  }

  /** Marks a doc as wanted: loads it and asks every peer for its state (and future updates). */
  async openDoc(docId: string) {
    await this.o.model.getDoc(docId);
    for (const c of this.conns.keys()) await this.requestDoc(c, docId);
  }

  /**
   * Asks every peer again for the state of every document we know or requested (a lost or never-sent answer is
   * recovered), then requests the documents of all text files. Used by "Sync now".
   */
  async resync() {
    const ids = new Set(await this.o.model.knownDocIds());
    for (const f of this.o.model.list()) if (f.kind === 'text') ids.add(`f:${f.id}`);
    for (const set of this.requested.values()) for (const id of set) ids.add(id);
    for (const c of this.conns.keys()) {
      const req = this.requested.get(c);
      for (const id of ids) {
        req?.add(id);
        const doc = await this.o.model.getDoc(id);
        await this.safeSend(c, MsgType.STEP1, packDoc(id, Y.encodeStateVector(doc)));
      }
    }
  }

  /** Fetches every text file's document from peers (compile leader, export, mirror). */
  async prefetchAll() {
    for (const f of this.o.model.list()) if (f.kind === 'text') await this.openDoc(`f:${f.id}`);
  }

  // ---- inbound ----

  private async onFrame(conn: PeerConnection, type: number, payload: Uint8Array) {
    const info = this.conns.get(conn);
    if (!info) return;
    try {
      if (type === MsgType.STEP1 || type === MsgType.STEP2 || type === MsgType.UPDATE) await this.syncGate;
      switch (type) {
        case MsgType.STEP1: {
          const { docId, data } = unpackDoc(payload);
          this.interest.get(conn)?.add(docId);
          if (!(await this.hasDoc(docId))) {
            // A file we know whose content is empty has no stored document: answer with an empty state so the peer
            // can tell "nothing to receive" from "no answer".
            if (docId.startsWith('f:') && this.o.model.byId(docId.slice(2))) {
              await this.safeSend(conn, MsgType.STEP2, packDoc(docId, Y.encodeStateAsUpdate(new Y.Doc())));
            }
            return;
          }
          const doc = await this.o.model.getDoc(docId);
          await this.safeSend(conn, MsgType.STEP2, packDoc(docId, Y.encodeStateAsUpdate(doc, data)));
          // Ask for their state as well if we have not yet.
          await this.requestDoc(conn, docId);
          return;
        }
        case MsgType.STEP2:
        case MsgType.UPDATE: {
          const { docId, data } = unpackDoc(payload);
          if (data.length > MAX_UPDATE) return;
          if (!this.interest.get(conn)?.has(docId) && !this.requested.get(conn)?.has(docId)) return;
          const doc = await this.o.model.getDoc(docId);
          // Waiting for the gate and the load can outlive the connection, its replacement, or the sender's role.
          if (this.conns.get(conn) !== info || conn.role === 'viewer' || info.claims.role === 'viewer') return;
          if (!this.interest.get(conn)?.has(docId) && !this.requested.get(conn)?.has(docId)) return;
          Y.applyUpdate(doc, data, conn);
          for (const cb of this.docSyncedCbs) cb(docId, info);
          return;
        }
        case MsgType.AWARENESS:
          applyAwarenessUpdate(this.awareness, payload, conn);
          return;
        case MsgType.EPOCH: {
          const { epoch, ticket } = parseJson<{ epoch?: unknown; ticket?: unknown }>(payload);
          // Only a verified same-project ticket moves the enforced epoch (to the epoch it carries). A bare number,
          // or evidence that fails verification, is at most a hint to refresh our own ticket.
          const verified = typeof ticket === 'string' ? await this.verifyEvidence(ticket) : null;
          if (verified) this.noteEpoch(verified, ticket as string);
          else if (typeof epoch === 'number' && Number.isSafeInteger(epoch)) this.noteEpochHint(epoch);
          return;
        }
        case MsgType.APP: {
          const { topic, body } = parseJson<{ topic: string; body: unknown }>(payload);
          if (typeof topic !== 'string') return;
          for (const h of this.appHandlers.get(topic) ?? []) h(info, body);
          return;
        }
        default:
          this.rawHandlers.get(type)?.(info, payload);
      }
    } catch {
      /* malformed frame from a peer: ignore */
    }
  }

  private async hasDoc(docId: string) {
    if (docId === ROOT_DOC_ID || this.o.model.getLoadedDoc(docId)) return true;
    return (await this.o.model.store.listDocs()).includes(docId);
  }

  // ---- outbound ----

  private onLocalDocUpdate(docId: string, update: Uint8Array, origin: unknown) {
    if (origin instanceof DocPersister) return;
    const fromConn = origin instanceof PeerConnection ? origin : undefined;
    // Peers that are not editors never send us document updates, so nothing here needs a role check.
    const frame = packDoc(docId, update);
    for (const [c, set] of this.interest) if (set.has(docId) && this.shouldRelay(fromConn, c)) void this.safeSend(c, MsgType.UPDATE, frame);
  }

  broadcast(type: number, payload: Uint8Array, noCompress = false) {
    for (const c of this.conns.keys()) void this.safeSend(c, type, payload, noCompress);
  }

  async sendTo(deviceId: string, type: number, payload: Uint8Array, noCompress = false) {
    for (const [c, i] of this.conns) if (i.deviceId === deviceId) await this.safeSend(c, type, payload, noCompress);
  }

  broadcastApp(topic: string, body: unknown) {
    this.broadcast(MsgType.APP, jsonBytes({ topic, body }));
  }
  async sendApp(deviceId: string, topic: string, body: unknown) {
    await this.sendTo(deviceId, MsgType.APP, jsonBytes({ topic, body }));
  }

  // ---- membership epoch / ticket policy ----

  private async verifyEvidence(ticket: string): Promise<TicketClaims | null> {
    try {
      const claims = await verifyTicket(ticket, this.o.trusted, this.o.now ? { now: this.o.now() } : {});
      return claims.pid === this.o.projectId ? claims : null;
    } catch {
      return null;
    }
  }

  private epochFrame() {
    return jsonBytes({ epoch: this.maxEpoch, ...(this.epochEvidence ? { ticket: this.epochEvidence.raw } : {}) });
  }

  /** Advances the enforced epoch from a ticket whose signature, project and expiry were verified. */
  private noteEpoch(claims: TicketClaims, raw: string) {
    const e = claims.ep;
    if (e < this.maxEpoch) return;
    if (e === this.maxEpoch) {
      if (!this.epochEvidence || claims.exp > this.epochEvidence.claims.exp) this.epochEvidence = { raw, claims };
      return;
    }
    this.maxEpoch = e;
    this.epochEvidence = { raw, claims };
    const now = this.now();
    this.maxEpochSince = now;
    for (const cb of this.epochCbs) cb(e);
    for (const [c, i] of this.conns) if ((c.claims ?? i.claims).ep < e && !this.staleSince.has(c)) this.staleSince.set(c, now);
    this.broadcast(MsgType.EPOCH, this.epochFrame());
  }

  /** A peer claims a newer epoch without proof: never policy, only a rate-limited prompt to refresh our ticket. */
  private noteEpochHint(e: number) {
    if (e <= this.maxEpoch) return;
    const now = this.now();
    if (now - this.lastHintRefreshAt < (this.o.epochHintRefreshMs ?? 30_000)) return;
    this.lastHintRefreshAt = now;
    for (const cb of this.epochCbs) cb(e);
  }

  private noteDeviceTicket(c: TicketClaims) {
    const m = this.deviceMarks.get(c.dev);
    this.deviceMarks.set(c.dev, { ep: Math.max(m?.ep ?? 0, c.ep), iat: Math.max(m?.iat ?? 0, c.iat) });
  }

  /**
   * The control plane issued us a fresh ticket: after verifying it like any peer's, share it so peers see our current
   * role and epoch, and advance our own enforced epoch. Resolves false (sharing nothing) for an invalid ticket.
   */
  async refreshOwnTicket(ticket: string): Promise<boolean> {
    const claims = await this.verifyEvidence(ticket);
    if (!claims) return false;
    this.broadcast(MsgType.TICKET, jsonBytes({ ticket }));
    this.noteEpoch(claims, ticket);
    return true;
  }

  private onTicketRefreshed(conn: PeerConnection, claims: TicketClaims) {
    const info = this.conns.get(conn);
    if (info) info.claims = claims;
    this.noteDeviceTicket(claims);
    this.noteEpoch(claims, conn.ticketRaw);
    if (claims.ep >= this.maxEpoch) this.staleSince.delete(conn);
    else if (!this.staleSince.has(conn)) this.staleSince.set(conn, this.now());
  }

  /** Keeps traffic flowing and drops peers that went silent (closed laptop, killed tab, lost network). */
  private checkLiveness() {
    const now = Date.now();
    const dead = this.o.deadAfterMs ?? 20_000;
    for (const conn of this.conns.keys()) {
      if (now - conn.lastRx > dead) conn.close();
      else void this.safeSend(conn, MsgType.APP, jsonBytes({ topic: 'ping', body: now }));
    }
  }

  /** Disconnects peers whose ticket expired or whose epoch stayed behind for longer than the grace period. */
  enforcePolicy() {
    const now = this.now();
    const grace = this.o.epochGraceMs ?? 60_000;
    for (const [conn, info] of this.conns) {
      const c = conn.claims ?? info.claims;
      info.claims = c;
      if (c.exp * 1000 + 30_000 < now) {
        conn.close();
        continue;
      }
      if (c.ep < this.maxEpoch) {
        const since = this.staleSince.get(conn) ?? now;
        this.staleSince.set(conn, since);
        if (now - since > grace) conn.close();
      } else this.staleSince.delete(conn);
    }
  }

  destroy() {
    clearInterval(this.policyTimer);
    if (this.nbrsTimer) clearTimeout(this.nbrsTimer);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.unsub();
    for (const c of [...this.conns.keys()]) c.close();
    this.awareness.destroy();
  }
}

export { LOCAL_ORIGIN };
export type { AppHandler, RawHandler };
