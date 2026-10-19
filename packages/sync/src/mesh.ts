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
import { AuthoredOrigin, signOperation, verifyOperation, readAuthoredOperation, storeAuthoredOperation, type AuthoredOperation } from './authorship.js';
import { fromB64u, toB64u } from '@hivetex/crypto';
import { authoredSource, projectAuthoredOperation, projectViews } from './history-projection.js';
import { type OperationView, viewOf } from './operation-view.js';
import type { ChangeSet } from './persistence.js';
import { preserveRecovery } from './recovery.js';
import { MIRROR_ORIGIN, IMPORT_ORIGIN, RESTORE_ORIGIN } from './origins.js';
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
  /**
   * `beforeSync` rejected: nothing may be exchanged with that peer in this attempt (its documents would still hold
   * unmerged work), so its connection is closed and the error reported here. The next link runs `beforeSync` again.
   */
  onSyncGateError?: (peer: PeerInfo, error: unknown) => void;
  /**
   * Whether this device announces and answers correlated synchronization receipts (default true). Off, it behaves
   * like a client that predates them (plain STEP1/STEP2 only), which is how interoperability is tested.
   */
  receipts?: boolean;
  /** How long an unanswered legacy exchange keeps blocking later requests for the same document (default 15 s). */
  legacySlotMs?: number;
  /** A requested history record not received within this long is skipped and reported (default 30 s). */
  historyWantTimeoutMs?: number;
  /** Signed operations of one author on one document closer together than this form one Changes group (default 3 s). */
  authoredGroupIdleMs?: number;
}

/** Live signed operations of one author on one document, coalesced so history grows with the change, not per keystroke. */
interface AuthoredGroup {
  key: string;
  docId: string;
  set: ChangeSet;
  before: OperationView | null;
  after: OperationView | null;
  idle: ReturnType<typeof setTimeout> | null;
  write: ReturnType<typeof setTimeout> | null;
}

/** How one reconciliation of a document ended. */
export type ReconcileOutcome = 'confirmed' | 'unavailable' | 'timeout' | 'cancelled' | 'disconnected';

export interface ReconcileResult {
  docId: string;
  outcome: ReconcileOutcome;
  /** The device whose confirmation completed the round. */
  source?: string;
  /** For `unavailable`: `no-peer` (nobody eligible is connected) or `not-held` (the peers answered but cannot confirm). */
  reason?: 'no-peer' | 'not-held';
}

export interface ReconcileOptions {
  signal?: AbortSignal;
  /** Gives up (outcome `timeout`) after this long. Default 8 s. */
  timeoutMs?: number;
}

export interface ProjectReconcile {
  /** Every text file's content (and the file table) is complete on this device. */
  complete: boolean;
  /** The documents requested in this round, with how each ended. */
  docs: ReconcileResult[];
  /** The documents that are not complete on this device afterwards. */
  missing: Array<{ docId: string; fileId?: string; path?: string; outcome: ReconcileOutcome | 'local' }>;
}

/** One request for a document's state to one connection (a "round"); see Mesh.reconcile. */
interface Exchange {
  id: number;
  docId: string;
  /** STEP1 was handed to the connection (and `startedAt` set). */
  sent: boolean;
  /** STEP1 has left; the correlated request may follow. */
  step1Sent: boolean;
  /** The correlated request ('sync-req') was sent. */
  req: boolean;
  startedAt: number;
  /** Nobody ever waited for it (startup exchange): its answer still counts, but it does not hold a legacy slot forever. */
  background: boolean;
  /** Its waiter gave up (timeout, cancel): a late answer completes nothing. */
  abandoned: boolean;
  waiter: ((o: 'confirmed' | 'unavailable' | 'disconnected') => void) | null;
}

export interface PeerInfo {
  deviceId: string;
  claims: TicketClaims;
  conn: PeerConnection;
  /** Latest raw ticket of the peer. */
  readonly ticket: string;
  /** Which connection this is: a device that reconnects gets a new one, so state tied to it starts over. */
  readonly gen: number;
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
  /** Signing is ordered (each operation names the previous one); it never waits for storage. */
  private signing: Promise<unknown> = Promise.resolve();
  private authoredSeen = new Set<string>();
  private authoredTip = new Map<string, string>();
  /** Signed operations still to be stored locally, retried in the background (see storeProvenance). */
  private provenance: AuthoredOperation[] = [];
  private provenanceRound: Array<() => void> = [];
  private provenanceWorker: Promise<void> | null = null;
  private authoredGroups = new Map<string, AuthoredGroup>();
  /** Live frames per connection; retained history waits for them to drain before each part. */
  private liveSends = new Map<PeerConnection, { tail: Promise<void>; depth: number }>();
  private historySends = new Map<PeerConnection, Promise<void>>();
  private historyWant = new Map<PeerConnection, ReturnType<typeof setTimeout>>();
  private historyIncomplete = new Set<PeerConnection>();
  readonly historySkipped: Array<{ id: string; device: string; reason: string }> = [];
  private closed = false;
  private safetyPeers = new Set<PeerConnection>();
  private historyPending = new Map<PeerConnection, { ids: string[]; next: string | null }>();
  private historyParts = new Map<PeerConnection, { id: string; parts: Uint8Array[]; total: number; size: number; live: boolean; at: number }>();
  private historyCbs = new Set<() => void>();
  private historyReceived = 0;
  private admissions = new Map<PeerConnection, Promise<void>>();
  private quarantined = new Map<PeerConnection, Set<string>>();
  private historyComplete = new Set<PeerConnection>();
  /** `complete`: every connected peer's retained history arrived. `incomplete`: paging finished but records were skipped. */
  get historyStatus() {
    const conns = [...this.conns.keys()];
    const settled = conns.length > 0 && conns.every((c) => this.historyComplete.has(c));
    const skippedHere = conns.some((c) => this.historyIncomplete.has(c));
    return { complete: settled && !skippedHere, incomplete: settled && skippedHere, skipped: this.historySkipped.length, received: this.historyReceived, pending: this.historyPending.size, legacyPeers: conns.filter((c) => !this.safetyPeers.has(c)).length, quarantined: [...this.quarantined.values()].reduce((n, docs) => n + docs.size, 0) };
  }
  onHistory(cb: () => void) { this.historyCbs.add(cb); return () => { this.historyCbs.delete(cb); }; }
  private historyChanged() { for (const cb of this.historyCbs) cb(); }
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
  /** What each peer announced it can do (see 'sync-caps'). */
  private caps = new Map<PeerConnection, { receipts: boolean }>();
  /** Outstanding requests per connection and document: a connection is one generation, a new one starts empty. */
  private exchanges = new Map<PeerConnection, Map<string, Exchange[]>>();
  /** Documents whose state a peer confirmed on this connection. */
  private confirmed = new Map<PeerConnection, Set<string>>();
  /** Frames being processed per connection: an answer is only complete once everything it follows has been applied. */
  private applying = new Map<PeerConnection, Set<Promise<unknown>>>();
  private reconciledCbs = new Set<(docId: string, from: PeerInfo) => void>();
  private exchangeSeq = 0;
  private connSeq = 0;
  private slotTimers = new Set<ReturnType<typeof setTimeout>>();
  private maxEpoch = 0;
  private maxEpochSince = 0;
  /** The verified ticket that proves `maxEpoch`; relayed so peers can verify the epoch themselves. */
  private epochEvidence: { raw: string; claims: TicketClaims } | null = null;
  private lastHintRefreshAt = 0;
  /** Newest verified (epoch, issued-at) and newest ticket seen per device in this session; survives connection replacement. */
  private deviceMarks = new Map<string, { ep: number; iat: number; newest: TicketClaims }>();
  /** Signed operations whose device has not yet shown a ticket for the enforced epoch (see admitSigner). */
  private held = new Map<string, Array<{ info: PeerInfo; payload: Uint8Array }>>();
  private epochCbs = new Set<(epoch: number) => void>();
  private policyTimer: ReturnType<typeof setInterval>;
  /** Document frames wait for this (see MeshOptions.beforeSync). */
  private syncGate: Promise<void> = Promise.resolve();
  /** Connections whose `beforeSync` failed: no document frame is read from or sent to them. */
  private gateFailed = new WeakSet<PeerConnection>();
  private unsub: () => void;
  readonly rejected: string[] = [];

  constructor(private o: MeshOptions) {
    try {
      const local = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(o.getTicket().split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? ''), (c) => c.charCodeAt(0)))) as TicketClaims;
      o.model.localAuthor = { uid: local.uid, device: local.dev, name: local.uname };
    } catch { /* Local-only and not-yet-authenticated projects retain explicit device attribution. */ }
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
    if (o.receipts !== false) {
      this.onApp('sync-caps', (from, body) => this.onCaps(from, body));
      this.onApp('sync-req', (from, body) => void this.answerRequest(from, body));
    }
    // Answers are honoured even with receipts off locally only if a request was made, which cannot happen then.
    this.onApp('sync-ack', (from, body) => void this.onAck(from, body));
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

  /** Returns a function that removes the handler again. */
  onPeerJoin(cb: (p: PeerInfo) => void) {
    this.joinCbs.add(cb);
    return () => void this.joinCbs.delete(cb);
  }
  onPeerLeave(cb: (p: PeerInfo) => void) {
    this.leaveCbs.add(cb);
    return () => void this.leaveCbs.delete(cb);
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
   * Fires when a peer's answer to a current request of this connection was applied (the peer has nothing more for the
   * document than we now hold; `model.availability` says whether our copy became complete). Unlike onDocSynced, an
   * incremental update or a reply to an older request never fires it.
   */
  onDocReconciled(cb: (docId: string, from: PeerInfo) => void) {
    this.reconciledCbs.add(cb);
    return () => this.reconciledCbs.delete(cb);
  }
  /**
   * `editorOnly` topics are privileged: the sender's role is checked when the message is dispatched (not when the
   * frame was decoded), so a demoted peer's message is never handed to the handler.
   */
  onApp(topic: string, h: AppHandler, opts: { editorOnly?: boolean } = {}) {
    const s = this.appHandlers.get(topic) ?? new Set();
    const wrapped: AppHandler = opts.editorOnly ? (from, body) => (from.claims.role === 'viewer' || from.conn.role === 'viewer' ? undefined : h(from, body)) : h;
    s.add(wrapped);
    this.appHandlers.set(topic, s);
    return () => void s.delete(wrapped);
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
      gen: ++this.connSeq,
    };
    // The same device reconnecting (page reloaded, app restarted) replaces its lingering old connection.
    for (const [old, oi] of this.conns) if (oi.deviceId === claims.dev) old.close();
    this.conns.set(conn, info);
    this.interest.set(conn, new Set());
    this.requested.set(conn, new Set());
    this.exchanges.set(conn, new Map());
    this.confirmed.set(conn, new Set());
    this.applying.set(conn, new Set());
    if (this.o.beforeSync) {
      const run = this.o.beforeSync;
      this.syncGate = this.syncGate.then(async () => {
        try {
          await run(info);
        } catch (e) {
          // Fail closed: a rejected preparation must not turn into an unprepared exchange.
          this.gateFailed.add(conn);
          try {
            this.o.onSyncGateError?.(info, e);
          } catch {
            /* a reporting callback must not reopen the gate */
          }
          conn.close();
        }
      });
    }
    conn.onFrame((c, type, payload) => void this.onFrame(c, type, payload));
    conn.onTicketRefreshed((c, nc) => this.onTicketRefreshed(c, nc));
    conn.onClose(() => this.dropConn(conn));
    this.noteDeviceTicket(claims);
    this.noteEpoch(claims, conn.ticketRaw);
    for (const cb of this.joinCbs) cb(info);
    this.announceNeighbours();
    await this.safeSend(conn, MsgType.EPOCH, this.epochFrame());
    await this.safeSend(conn, MsgType.APP, jsonBytes({ topic: 'safety-caps', body: { v: 2, authored: true, tombstones: 'map' } }));
    if (this.o.receipts !== false) await this.safeSend(conn, MsgType.APP, jsonBytes({ topic: 'sync-caps', body: { v: 1, receipts: true } }));
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
    this.safetyPeers.delete(conn); this.historyPending.delete(conn); this.historyParts.delete(conn); this.historyComplete.delete(conn);
    this.quarantined.delete(conn); this.admissions.delete(conn); this.liveSends.delete(conn); this.historySends.delete(conn);
    for (const [dev, list] of this.held) {
      const kept = list.filter((h) => h.info.conn !== conn);
      if (kept.length) this.held.set(dev, kept); else this.held.delete(dev);
    }
    this.historyIncomplete.delete(conn); clearTimeout(this.historyWant.get(conn)); this.historyWant.delete(conn);
    this.historyChanged();
    this.interest.delete(conn);
    this.requested.delete(conn);
    this.staleSince.delete(conn);
    this.nbrs.delete(conn);
    this.caps.delete(conn);
    this.confirmed.delete(conn);
    this.applying.delete(conn);
    for (const list of this.exchanges.get(conn)?.values() ?? []) for (const ex of list) ex.waiter?.('disconnected');
    this.exchanges.delete(conn);
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
    if (this.gateFailed.has(conn)) return;
    const ids = await this.o.model.knownDocIds();
    // Root first, so the file table is current before file docs are reconciled.
    ids.sort((a, b) => (a === ROOT_DOC_ID ? -1 : b === ROOT_DOC_ID ? 1 : 0));
    // Viewers cannot supply state (their answers are not applied), so they are only asked as before.
    const viewer = conn.role === 'viewer' || this.conns.get(conn)?.claims.role === 'viewer';
    for (const id of ids) {
      if (viewer) await this.requestDoc(conn, id);
      else await this.begin(conn, id, null).sent;
    }
    await this.safeSend(conn, MsgType.AWARENESS, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
  }

  private async requestDoc(conn: PeerConnection, docId: string) {
    const req = this.requested.get(conn);
    if (!req || req.has(docId)) return;
    req.add(docId);
    const doc = await this.o.model.getDoc(docId);
    await this.safeSend(conn, MsgType.STEP1, packDoc(docId, Y.encodeStateVector(doc)));
  }

  // ---- reconciliation: requests whose answers are tied to this connection and this request ----

  /** Starts a request for the document's state on a connection; `waiter` hears how it ended (none: a startup request). */
  private begin(conn: PeerConnection, docId: string, waiter: Exchange['waiter']): { ex: Exchange; sent: Promise<void> } {
    const ex: Exchange = { id: ++this.exchangeSeq, docId, sent: false, step1Sent: false, req: false, startedAt: 0, background: !waiter, abandoned: false, waiter };
    const byDoc = this.exchanges.get(conn);
    if (!byDoc) {
      waiter?.('disconnected');
      return { ex, sent: Promise.resolve() };
    }
    const list = byDoc.get(docId) ?? [];
    list.push(ex);
    byDoc.set(docId, list);
    return { ex, sent: this.pump(conn, docId) };
  }

  private receiptsFrom(conn: PeerConnection) {
    return this.caps.get(conn)?.receipts === true;
  }

  /**
   * Sends what may be sent. Receipt-capable peers answer each request individually, so all go out. A legacy peer's
   * STEP2 cannot be matched to a request, so only one request per document is outstanding on its connection and the
   * others wait their turn; an unanswered one that nobody waits for stops blocking after `legacySlotMs`.
   */
  private pump(conn: PeerConnection, docId: string): Promise<void> {
    const byDoc = this.exchanges.get(conn);
    const list = byDoc?.get(docId);
    if (!byDoc || !list?.length) return Promise.resolve();
    if (this.receiptsFrom(conn)) return Promise.all(list.filter((e) => !e.sent).map((e) => this.transmit(conn, e))).then(() => {});
    const head = list[0] as Exchange;
    if (!head.sent) return this.transmit(conn, head);
    if (head.background || head.abandoned) {
      const left = head.startedAt + (this.o.legacySlotMs ?? 15_000) - Date.now();
      if (left <= 0) {
        list.shift();
        if (!list.length) byDoc.delete(docId);
        return this.pump(conn, docId);
      }
      const t = setTimeout(() => {
        this.slotTimers.delete(t);
        void this.pump(conn, docId);
      }, left + 1);
      (t as unknown as { unref?: () => void }).unref?.();
      this.slotTimers.add(t);
    }
    return Promise.resolve();
  }

  private async transmit(conn: PeerConnection, ex: Exchange) {
    ex.sent = true;
    ex.startedAt = Date.now();
    this.requested.get(conn)?.add(ex.docId);
    try {
      const doc = await this.o.model.getDoc(ex.docId);
      await this.safeSend(conn, MsgType.STEP1, packDoc(ex.docId, Y.encodeStateVector(doc)));
      ex.step1Sent = true;
      if (this.receiptsFrom(conn)) await this.sendRequest(conn, ex);
    } catch {
      /* the document could not be loaded: the request stays unanswered and times out */
    }
  }

  private async sendRequest(conn: PeerConnection, ex: Exchange) {
    if (ex.req || ex.abandoned) return;
    ex.req = true;
    await this.safeSend(conn, MsgType.APP, jsonBytes({ topic: 'sync-req', body: { docId: ex.docId, round: ex.id } }));
  }

  /** Ends a request: a confirmation completes the document locally (unless its waiter already gave up), then the next one may go. */
  private finish(conn: PeerConnection, ex: Exchange, end: 'confirmed' | 'unavailable', answered = true) {
    const byDoc = this.exchanges.get(conn);
    const list = byDoc?.get(ex.docId);
    const i = list ? list.indexOf(ex) : -1;
    if (!byDoc || !list || i < 0) return;
    list.splice(i, 1);
    if (!list.length) byDoc.delete(ex.docId);
    const info = this.conns.get(conn);
    if (end === 'confirmed' && info && !ex.abandoned) this.o.model.markComplete(ex.docId);
    // Any applied answer to a current request means this peer has nothing for the document that we lack, even when it
    // cannot vouch that its own copy is complete (a partial peer answers 'partial', a peer without it 'none').
    if (answered && info && !ex.abandoned) {
      this.confirmed.get(conn)?.add(ex.docId);
      for (const cb of this.reconciledCbs) cb(ex.docId, info);
    }
    ex.waiter?.(end);
    void this.pump(conn, ex.docId);
  }

  private abandon(conn: PeerConnection, ex: Exchange) {
    ex.waiter = null;
    ex.abandoned = true;
    // A receipt names its request, so nothing late can match it. A legacy STEP1 that went out is still owed an
    // answer: it keeps its place (and is consumed unused) until that answer comes or the slot expires.
    if (this.receiptsFrom(conn) || !ex.sent) {
      const byDoc = this.exchanges.get(conn);
      const list = byDoc?.get(ex.docId);
      if (list?.includes(ex)) {
        list.splice(list.indexOf(ex), 1);
        if (!list.length) byDoc?.delete(ex.docId);
      }
    }
    void this.pump(conn, ex.docId);
  }

  /** A legacy peer's STEP2 answers the one request outstanding for that document on this connection. */
  private onStep2Applied(conn: PeerConnection, docId: string) {
    if (this.receiptsFrom(conn)) return;
    const head = this.exchanges.get(conn)?.get(docId)?.[0];
    if (head?.sent) this.finish(conn, head, 'confirmed');
  }

  private onCaps(from: PeerInfo, body: unknown) {
    if ((body as { receipts?: unknown } | null)?.receipts !== true) return;
    const conn = from.conn;
    this.caps.set(conn, { receipts: true });
    // Requests sent before the announcement arrived can now be correlated; their answer comes with a receipt.
    for (const [docId, list] of this.exchanges.get(conn) ?? []) {
      for (const ex of [...list]) {
        if (ex.abandoned && ex.sent) list.splice(list.indexOf(ex), 1);
        else if (ex.step1Sent && !ex.req) void this.sendRequest(conn, ex);
      }
      void this.pump(conn, docId);
    }
  }

  /** What this device can promise about a document it is asked about: complete, only partly held, or not held at all. */
  private async statusOf(docId: string): Promise<'complete' | 'partial' | 'none'> {
    if (this.o.model.availability(docId) === 'complete') return 'complete';
    return (await this.hasDoc(docId)) ? 'partial' : 'none';
  }

  /** Answers a correlated request once the plain request it accompanies (and anything before it) has been handled. */
  private async answerRequest(from: PeerInfo, body: unknown) {
    const { docId, round } = (body ?? {}) as { docId?: unknown; round?: unknown };
    if (typeof docId !== 'string' || docId.length > 200 || typeof round !== 'number' || !Number.isSafeInteger(round)) return;
    await Promise.allSettled([...(this.applying.get(from.conn) ?? [])]);
    if (this.conns.get(from.conn) !== from) return;
    const status = await this.statusOf(docId);
    await this.safeSend(from.conn, MsgType.APP, jsonBytes({ topic: 'sync-ack', body: { docId, round, status } }));
  }

  /** A receipt completes the request it names, if that request is still current on this very connection. */
  private async onAck(from: PeerInfo, body: unknown) {
    const { docId, round, status } = (body ?? {}) as { docId?: unknown; round?: unknown; status?: unknown };
    if (typeof docId !== 'string' || typeof round !== 'number') return;
    const conn = from.conn;
    const ex = this.exchanges.get(conn)?.get(docId)?.find((e) => e.id === round);
    if (!ex?.sent) return;
    // The answer's state travels in frames before the receipt: wait until they are applied.
    await Promise.allSettled([...(this.applying.get(conn) ?? [])]);
    if (this.conns.get(conn) !== from || !this.exchanges.get(conn)?.get(docId)?.includes(ex)) return;
    // A viewer's state is never applied, so its receipt cannot vouch for anything.
    const viewer = from.claims.role === 'viewer' || conn.role === 'viewer';
    const held = this.quarantined.get(conn)?.has(docId);
    this.finish(conn, ex, status === 'complete' && !viewer && !held ? 'confirmed' : 'unavailable', !viewer && !held);
  }

  /** A peer answered a current request for this document on a connection that is still open (see onDocReconciled). */
  reconciled(docId: string): boolean {
    for (const set of this.confirmed.values()) if (set.has(docId)) return true;
    return false;
  }

  /** A request for the document is in flight on some connection (its answer has not been judged yet). */
  reconciling(docId: string): boolean {
    for (const byDoc of this.exchanges.values()) if (byDoc.get(docId)?.length) return true;
    return false;
  }

  /** Identifies the current set of connections (device and connection generation), for deciding whether a retry is due. */
  get sourceKey(): string {
    return this.peers
      .map((p) => `${p.deviceId}#${p.gen}`)
      .sort()
      .join(',');
  }

  /**
   * Asks the connected editors for the document's complete state and waits for a confirmation answering this very
   * request. Resolves `confirmed` (the document is now complete here: an empty answer included), `unavailable` (no
   * eligible peer, or none that can confirm), `timeout`, `cancelled` or `disconnected`. Incremental updates, replies to
   * earlier requests and other connections' answers never complete it. Viewers are not sources (their state is not applied).
   */
  async reconcile(docId: string, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
    const sources = this.peers.filter((p) => p.claims.role !== 'viewer' && p.conn.role !== 'viewer');
    if (opts.signal?.aborted) return { docId, outcome: 'cancelled' };
    if (!sources.length) return { docId, outcome: 'unavailable', reason: 'no-peer' };
    return new Promise<ReconcileResult>((resolve) => {
      const started: Array<[PeerConnection, Exchange]> = [];
      let settled = false;
      let open = sources.length;
      let refused = 0;
      const end = (r: ReconcileResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        for (const [c, ex] of started) this.abandon(c, ex);
        resolve(r);
      };
      const onAbort = () => end({ docId, outcome: 'cancelled' });
      const timer = setTimeout(() => end({ docId, outcome: 'timeout' }), opts.timeoutMs ?? 8000);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      for (const info of sources) {
        const { ex } = this.begin(info.conn, docId, (o) => {
          if (o === 'confirmed') return end({ docId, outcome: 'confirmed', source: info.deviceId });
          if (o === 'unavailable') refused++;
          if (--open === 0) end(refused ? { docId, outcome: 'unavailable', reason: 'not-held' } : { docId, outcome: 'disconnected' });
        });
        started.push([info.conn, ex]);
      }
    });
  }

  /**
   * Reconciles the file table first (so the list of files is current), then the text files' documents. `scope`:
   * `incomplete` asks only for documents not complete here, `pending` (default) also for complete ones no current
   * connection confirmed, `all` for everything this device knows. Reports which documents are still not complete here.
   */
  async reconcileProject(opts: ReconcileOptions & { scope?: 'incomplete' | 'pending' | 'all' } = {}): Promise<ProjectReconcile> {
    const { model } = this.o;
    const scope = opts.scope ?? 'pending';
    const due = (docId: string) => scope === 'all' || model.availability(docId) !== 'complete' || (scope === 'pending' && !this.reconciled(docId));
    const docs: ReconcileResult[] = [];
    const ask = async (ids: string[]) => {
      docs.push(...(await Promise.all(ids.map((id) => this.reconcile(id, opts)))));
    };
    if (this.peers.length > 0 && due(ROOT_DOC_ID)) await ask([ROOT_DOC_ID]);
    if (this.peers.length > 0) {
      const ids = new Set<string>();
      for (const f of model.list()) if (f.kind === 'text') ids.add(`f:${f.id}`);
      if (scope === 'all') {
        for (const id of await model.knownDocIds()) ids.add(id);
        for (const set of this.requested.values()) for (const id of set) ids.add(id);
      }
      ids.delete(ROOT_DOC_ID);
      await ask([...ids].filter(due));
    }
    return this.projectState(docs);
  }

  /** The documents of the project that are not complete on this device, and the outcomes of `docs`. */
  private projectState(docs: ReconcileResult[]): ProjectReconcile {
    const { model } = this.o;
    const by = new Map(docs.map((d) => [d.docId, d.outcome] as const));
    const missing: ProjectReconcile['missing'] = [];
    if (model.availability(ROOT_DOC_ID) !== 'complete') missing.push({ docId: ROOT_DOC_ID, outcome: by.get(ROOT_DOC_ID) ?? 'local' });
    for (const f of model.missingText()) missing.push({ docId: `f:${f.id}`, fileId: f.id, path: f.path, outcome: by.get(`f:${f.id}`) ?? 'local' });
    return { complete: missing.length === 0, docs, missing };
  }

  /**
   * For consumers that need the whole project (export, compile, backup, mirror): resolves at once when every document is
   * complete on this device (also offline), otherwise asks the peers for what is missing and reports what remains
   * unavailable. It never substitutes empty text for missing content.
   */
  async awaitComplete(opts: ReconcileOptions = {}): Promise<ProjectReconcile> {
    const now = this.projectState([]);
    if (now.complete) return now;
    return this.reconcileProject({ ...opts, scope: 'incomplete' });
  }

  /** Marks a doc as wanted: loads it and asks every peer for its state (and future updates). */
  async openDoc(docId: string) {
    await this.o.model.getDoc(docId);
    for (const c of this.conns.keys()) await this.requestDoc(c, docId);
  }

  /**
   * Asks every peer again for the state of every document we know or requested (a lost or never-sent answer is
   * recovered), then requests the documents of all text files, and waits for the answers (each document: see
   * `reconcile`). Used by "Sync now".
   */
  async resync(opts: ReconcileOptions = {}): Promise<ProjectReconcile> {
    return this.reconcileProject({ ...opts, scope: 'all' });
  }

  /** Fetches every text file's document from peers (local compilation, export, mirror). */
  async prefetchAll() {
    for (const f of this.o.model.list()) if (f.kind === 'text') await this.openDoc(`f:${f.id}`);
  }

  // ---- inbound ----

  private onFrame(conn: PeerConnection, type: number, payload: Uint8Array): Promise<void> {
    let authoredPart = false;
    if (type === MsgType.APP) {
      try { const message = parseJson<{ topic?: string; body?: { live?: boolean } }>(payload); authoredPart = message.topic === 'history-part' && message.body?.live === true; }
      catch { /* handleFrame rejects malformed input */ }
    }
    const work = this.handleFrame(conn, type, payload);
    if (type === MsgType.STEP1 || type === MsgType.STEP2 || type === MsgType.UPDATE || type === MsgType.AUTHORED || authoredPart) {
      // Registered before anything is awaited, so a receipt that follows can wait for exactly the frames before it.
      const set = this.applying.get(conn);
      if (set) {
        set.add(work);
        void work.finally(() => set.delete(work));
      }
    }
    return work;
  }

  private async handleFrame(conn: PeerConnection, type: number, payload: Uint8Array) {
    const info = this.conns.get(conn);
    if (!info) return;
    try {
      if (type === MsgType.STEP1 || type === MsgType.STEP2 || type === MsgType.UPDATE || type === MsgType.AUTHORED) {
        await this.syncGate;
        if (this.gateFailed.has(conn)) return;
      }
      switch (type) {
        case MsgType.AUTHORED: {
          const queued = (this.admissions.get(conn) ?? Promise.resolve()).catch(() => {}).then(() => this.applyAuthored(info, payload));
          this.admissions.set(conn, queued);
          try { await queued; }
          finally { if (this.admissions.get(conn) === queued) this.admissions.delete(conn); }
          return;
        }
        case MsgType.STEP1: {
          const { docId, data } = unpackDoc(payload);
          this.interest.get(conn)?.add(docId);
          if (!(await this.hasDoc(docId))) {
            // A file created here with no content has no stored document: answer with an empty state so the peer
            // can tell "nothing to receive" from "no answer". A file we merely know by name is not known to be empty.
            if (docId.startsWith('f:') && this.o.model.availability(docId) === 'complete') {
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
          if (!await this.admitRootUpdate(conn, docId, doc, data, `${info.claims.uname} (device ${info.deviceId})`)) return;
          Y.applyUpdate(doc, data, conn);
          await this.o.model.flush();
          for (const cb of this.docSyncedCbs) cb(docId, info);
          if (type === MsgType.STEP2) this.onStep2Applied(conn, docId);
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
          if (topic === 'safety-caps' || topic.startsWith('history-')) { await this.onHistoryMessage(info, topic, body); return; }
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
    // Any other source touching the document ends the coalesced groups of other authors on it (no mixed attribution).
    this.endAuthoredGroups(docId, origin instanceof AuthoredOrigin ? this.groupKey(origin.operation, origin.claims) : null);
    if (origin instanceof AuthoredOrigin) return;
    const fromConn = origin instanceof PeerConnection ? origin : undefined;
    if (!fromConn) {
      const captured = update.slice();
      const ticket = this.o.getTicket();
      // Offline/local projects still journal every operation. They must not wait for an unavailable membership
      // certificate merely to acknowledge their own durable data; synchronization authenticates on reconnect.
      try { const claims = JSON.parse(new TextDecoder().decode(fromB64u(ticket.split('.')[1] ?? ''))) as TicketClaims; if (claims.pid !== this.o.projectId || claims.role === 'viewer') return; }
      catch { return; }
      // Previous releases (0.8.0) cannot read signed operations: they get the plain update at once.
      for (const [c, set] of this.interest) if (set.has(docId) && !this.safetyPeers.has(c)) void this.sendLive(c, MsgType.UPDATE, packDoc(docId, captured));
      const at = this.now();
      const source = origin === MIRROR_ORIGIN || (origin as { kind?: string } | null)?.kind === 'folder' ? 'folder' : origin === 'changelog-undo' ? 'undo' : origin === IMPORT_ORIGIN ? 'import' : origin === RESTORE_ORIGIN ? 'restore' : 'editor';
      const legacy = new Set([...this.interest.keys()].filter((c) => !this.safetyPeers.has(c)));
      // Signing is ordered and fast; sending follows it directly. Storing the evidence is retried apart (storeProvenance).
      const signed = this.signing.then(async () => {
        const tip = this.authoredTip.get(docId);
        const op = await signOperation({ pid: this.o.projectId, docId, update: captured, ticket, source, dependencies: tip ? [tip] : [], at }, this.o.keys);
        this.authoredTip.set(docId, op.id);
        this.authoredSeen.add(op.id);
        return op;
      });
      this.signing = signed.catch(() => {});
      // flush() covers signing and the first storage attempt, never the retries after it.
      this.o.model.trackDurability(signed.then((op) => {
        if (this.closed) return;
        for (const [c, set] of this.interest) if (set.has(docId) && this.safetyPeers.has(c) && !legacy.has(c)) void this.sendOperationLive(c, op);
        return this.storeProvenance(op);
      }).catch(() => {}));
      return;
    }
    // Legacy bootstrap updates have unknown original provenance; never relabel them as the forwarding author.
    const frame = packDoc(docId, update);
    for (const [c, set] of this.interest) if (set.has(docId) && this.shouldRelay(fromConn, c)) void this.sendLive(c, MsgType.UPDATE, frame);
  }

  broadcast(type: number, payload: Uint8Array, noCompress = false) {
    for (const c of this.conns.keys()) void this.safeSend(c, type, payload, noCompress);
  }

  /** Live frames keep their order per connection; retained history waits for them (see sendHistory). */
  private sendLive(conn: PeerConnection, type: number, payload: Uint8Array): Promise<void> {
    const q = this.liveSends.get(conn) ?? { tail: Promise.resolve(), depth: 0 };
    this.liveSends.set(conn, q);
    q.depth++;
    const next = q.tail.then(() => this.safeSend(conn, type, payload)).finally(() => { q.depth--; });
    q.tail = next.catch(() => {});
    return next;
  }

  private sendOperationLive(conn: PeerConnection, operation: AuthoredOperation) {
    const bytes = jsonBytes(operation);
    if (bytes.length < 256 * 1024) return this.sendLive(conn, MsgType.AUTHORED, bytes);
    const chunk = 128 * 1024, total = Math.ceil(bytes.length / chunk);
    let last = Promise.resolve();
    for (let part = 0; part < total; part++) last = this.sendLive(conn, MsgType.APP, jsonBytes({ topic: 'history-part', body: { id: operation.id, part, total, live: true, data: toB64u(bytes.subarray(part * chunk, (part + 1) * chunk)) } }));
    return last;
  }

  /** Lower priority: every part waits until the connection's queued live frames are out, so edits never queue behind history. */
  private sendHistory(conn: PeerConnection, operation: AuthoredOperation) {
    const run = async () => {
      const bytes = jsonBytes(operation);
      const chunk = 128 * 1024, total = Math.ceil(bytes.length / chunk);
      for (let part = 0; part < total && this.conns.has(conn); part++) {
        for (let q = this.liveSends.get(conn); q && q.depth > 0; q = this.liveSends.get(conn)) await q.tail;
        await this.safeSend(conn, MsgType.APP, jsonBytes({ topic: 'history-part', body: { id: operation.id, part, total, live: false, data: toB64u(bytes.subarray(part * chunk, (part + 1) * chunk)) } }));
      }
    };
    const next = (this.historySends.get(conn) ?? Promise.resolve()).then(run, run);
    this.historySends.set(conn, next.catch(() => {}));
    return next;
  }

  /**
   * Stores signed evidence in the background, in order, retrying with backoff. A failure stays visible (saveState) but
   * neither delays live edits nor makes model.flush() reject; flush waits at most for the next storage attempt.
   */
  private storeProvenance(op: AuthoredOperation): Promise<void> {
    this.provenance.push(op);
    const attempted = new Promise<void>((resolve) => this.provenanceRound.push(resolve));
    this.o.model.trackDurability(attempted);
    this.provenanceWorker ??= (async () => {
      for (let n = 0; this.provenance.length && !this.closed; ) {
        const round = this.provenanceRound.splice(0);
        try {
          while (this.provenance.length) { await storeAuthoredOperation(this.o.model.store, this.provenance[0]!); this.provenance.shift(); }
          this.o.model.durabilityError('authorship', null);
          n = 0;
        } catch (error) {
          // Different evidence under the same id can never be stored: report it and keep the rest moving.
          if (error instanceof Error && error.message.includes('immutable evidence')) this.provenance.shift();
          this.o.model.durabilityError('authorship', error, { blocking: false });
        } finally { for (const resolve of round) resolve(); }
        if (this.provenance.length && !this.closed) await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** Math.min(n++, 6))));
      }
      for (const resolve of this.provenanceRound.splice(0)) resolve();
      this.provenanceWorker = null;
    })();
    return attempted;
  }

  private async applyAuthored(info: PeerInfo, payload: Uint8Array) {
    const conn = info.conn;
    const { operation, claims, update } = await verifyOperation(parseJson(payload), this.o.projectId, this.o.trusted, { now: this.o.now?.() });
    if (this.conns.get(conn) !== info || conn.role === 'viewer' || this.authoredSeen.has(operation.id)) return;
    if (!this.admitSigner(claims, info, payload)) return;
    if (!this.interest.get(conn)?.has(operation.docId) && !this.requested.get(conn)?.has(operation.docId)) return;
    const doc = await this.o.model.getDoc(operation.docId);
    if (this.conns.get(conn) !== info || info.claims.role === 'viewer' || claims.exp * 1000 + 30_000 < this.now()) return;
    if (!this.admitSigner(claims, info, payload)) return;
    if (!await this.admitRootUpdate(conn, operation.docId, doc, update, `${claims.uname} (device ${claims.dev})`)) return;
    // Different evidence under a known id is refused before anything is applied.
    const existing = await readAuthoredOperation(this.o.model.store, operation.id).catch(() => undefined);
    if (existing && existing.signature !== operation.signature) throw new Error('Operation ID already belongs to different immutable evidence');
    if (this.authoredSeen.has(operation.id) || this.conns.get(conn) !== info) return;
    this.authoredSeen.add(operation.id);
    // This replica's own projection around the change is its preimage: nothing of the kind travels in the envelope.
    const before = viewOf(operation.docId, doc);
    Y.applyUpdate(doc, update, new AuthoredOrigin(operation, claims, conn));
    const after = viewOf(operation.docId, doc);
    // Forward before storing anything; previous releases (0.8.0) drop signed frames, so they get the plain update.
    // Forward even when Yjs is waiting for a dependency and emitted no update event.
    for (const [c, set] of this.interest) if (set.has(operation.docId) && this.shouldRelay(conn, c)) {
      if (this.safetyPeers.has(c)) void this.sendOperationLive(c, operation);
      else void this.sendLive(c, MsgType.UPDATE, packDoc(operation.docId, update));
    }
    if (!existing) this.storeProvenance(operation);
    this.recordAuthored(operation, claims, before, after);
    this.historyChanged();
    await this.o.model.flush();
    for (const cb of this.docSyncedCbs) cb(operation.docId, info);
  }

  private groupKey(op: Pick<AuthoredOperation, 'docId' | 'source'>, claims: Pick<TicketClaims, 'uid' | 'dev'>) {
    return `${claims.uid}|${claims.dev}|${op.docId}|${op.source}`;
  }

  /** One Changes group per run of an author's live operations on a document: preimage once, written debounced. */
  private recordAuthored(op: AuthoredOperation, claims: TicketClaims, before: OperationView | null, after: OperationView | null) {
    if (!before || !after) { this.persistHistoryGroup(this.withPaths(projectAuthoredOperation(op, claims))); return; }
    const key = this.groupKey(op, claims);
    let g = this.authoredGroups.get(key);
    if (!g) {
      g = { key, docId: op.docId, before, after, idle: null, write: null,
        set: { id: `authored:${op.id}`, source: authoredSource(op, claims), startedAt: op.at, endedAt: op.at, files: [], operationIds: [] } };
      this.authoredGroups.set(key, g);
    }
    g.after = after;
    g.set.operationIds!.push(op.id);
    g.set.endedAt = Math.max(g.set.endedAt, op.at);
    const group = g;
    if (g.idle) clearTimeout(g.idle);
    g.idle = setTimeout(() => this.closeAuthoredGroup(group), this.o.authoredGroupIdleMs ?? 3000);
    g.write ??= setTimeout(() => { group.write = null; this.writeAuthoredGroup(group); }, 100);
  }

  private endAuthoredGroups(docId: string, except: string | null) {
    for (const g of [...this.authoredGroups.values()]) if (g.docId === docId && g.key !== except) this.closeAuthoredGroup(g);
  }

  private closeAuthoredGroup(g: AuthoredGroup) {
    if (this.authoredGroups.get(g.key) !== g) return;
    this.authoredGroups.delete(g.key);
    if (g.idle) clearTimeout(g.idle);
    if (g.write) clearTimeout(g.write);
    this.writeAuthoredGroup(g);
  }

  private writeAuthoredGroup(g: AuthoredGroup) {
    if (!g.before || !g.after) return;
    this.persistHistoryGroup(this.withPaths({ ...g.set, operationIds: [...g.set.operationIds!], files: projectViews(g.docId, g.before, g.after) }));
  }

  private withPaths(group: ChangeSet) {
    for (const file of group.files) file.path = this.o.model.byId(file.fileId)?.path ?? this.o.model.deletedFiles().find((f) => f.id === file.fileId)?.path ?? file.path;
    return group;
  }

  /**
   * A root update may physically remove entries (a previous release, or a deletion made before the upgrade). Each one
   * is retained in private Recovery first, then the update applies: root synchronization never stalls on it. Only an
   * unknown (future) tombstone format is held, with a notice to update.
   */
  private async admitRootUpdate(conn: PeerConnection, docId: string, doc: Y.Doc, data: Uint8Array, by: string) {
    if (docId !== ROOT_DOC_ID) return true;
    const preview = new Y.Doc();
    let future = false;
    const removed: Array<[string, Record<string, unknown>]> = [];
    try {
      Y.applyUpdate(preview, Y.encodeStateAsUpdate(doc)); Y.applyUpdate(preview, data);
      const files = preview.getMap<Y.Map<unknown>>('files'), tombstones = preview.getMap<{ v?: unknown }>('tombstones');
      future = [...tombstones.values()].some((t) => t?.v !== 1) || [...files.values()].some((entry) => {
        const deletion = entry instanceof Y.Map ? entry.get('deleted') as { v?: unknown } | undefined : undefined;
        return !!deletion && deletion.v !== 1;
      });
      for (const [id, entry] of doc.getMap<Y.Map<unknown>>('files')) if (!files.has(id) && !tombstones.has(id)) removed.push([id, entry.toJSON() as Record<string, unknown>]);
    } finally { preview.destroy(); }
    if (future) {
      await preserveRecovery(this.o.model.store, 'Quarantined sync root update', data, `Unsupported deletion format from ${by}; update this app`);
      const held = this.quarantined.get(conn) ?? new Set<string>(); held.add(docId); this.quarantined.set(conn, held);
      this.historyChanged(); return false;
    }
    for (const [id, entry] of removed) {
      if (entry.kind === 'dir') continue;
      const bytes = entry.kind === 'text' ? new TextEncoder().encode((await this.o.model.openText(id)).toString())
        : (typeof entry.hash === 'string' ? await this.o.model.store.getBlob(entry.hash) : undefined) ?? new Uint8Array();
      await preserveRecovery(this.o.model.store, String(entry.path), bytes, `Removed by ${by} without a recoverable deletion`, { kind: 'removed', fileId: id });
    }
    if (this.quarantined.get(conn)?.delete(docId)) this.historyChanged();
    return true;
  }

  /** Display history is stored in the background with retry: it never holds the frames behind it. */
  private persistHistoryGroup(group: ChangeSet) {
    void (async () => {
      for (let n = 0; ; n++) {
        try { await this.o.model.store.putChangeSet(group); this.o.model.durabilityError('received-history', null); this.historyChanged(); return; }
        catch (error) {
          this.o.model.durabilityError('received-history', error, { blocking: false });
          if (this.closed) return;
          await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** Math.min(n, 6))));
        }
      }
    })();
  }

  private async requestHistoryNext(info: PeerInfo) {
    const pending = this.historyPending.get(info.conn);
    clearTimeout(this.historyWant.get(info.conn));
    this.historyWant.delete(info.conn);
    if (!pending) return;
    if (pending.ids.length) {
      const id = pending.ids[0]!;
      this.armHistoryWant(info, id);
      await this.sendApp(info.deviceId, 'history-want', { id });
    } else if (pending.next !== null) await this.sendApp(info.deviceId, 'history-list', { cursor: pending.next });
    else { this.historyPending.delete(info.conn); this.historyComplete.add(info.conn); this.historyChanged(); }
  }

  /** An unanswered (or stalled) record is skipped after a bounded time; any received part rearms it. */
  private armHistoryWant(info: PeerInfo, id: string) {
    clearTimeout(this.historyWant.get(info.conn));
    const t = setTimeout(() => {
      if (this.historyPending.get(info.conn)?.ids[0] === id) void this.skipHistory(info, id, 'no answer');
    }, this.o.historyWantTimeoutMs ?? 30_000);
    (t as unknown as { unref?: () => void }).unref?.();
    this.historyWant.set(info.conn, t);
  }

  /** A record that cannot be verified, stored or received is reported and skipped; paging continues. */
  private async skipHistory(info: PeerInfo, id: string, reason: string) {
    if (this.conns.get(info.conn) !== info) return;
    this.historySkipped.push({ id, device: info.deviceId, reason });
    if (this.historySkipped.length > 1000) this.historySkipped.shift();
    this.historyIncomplete.add(info.conn);
    if (this.historyParts.get(info.conn)?.id === id) this.historyParts.delete(info.conn);
    const pending = this.historyPending.get(info.conn);
    if (pending?.ids[0] === id) pending.ids.shift();
    this.historyChanged();
    await this.requestHistoryNext(info);
  }

  private async onHistoryMessage(info: PeerInfo, topic: string, value: unknown) {
    const body = (value ?? {}) as Record<string, unknown>;
    if (topic === 'safety-caps') {
      // v1 (unreleased: signed full preimages, tombstones inside `files`) is not interoperable and is treated as legacy.
      if (body.v !== 2 || body.authored !== true || body.tombstones !== 'map') return;
      this.safetyPeers.add(info.conn);
      this.historyComplete.delete(info.conn);
      await this.sendApp(info.deviceId, 'history-list', { cursor: '' });
      this.historyChanged(); return;
    }
    if (!this.safetyPeers.has(info.conn)) return;
    if (topic === 'history-list') {
      if (typeof body.cursor !== 'string' || body.cursor.length > 100) return;
      const ids = (await this.o.model.store.listMetaKeys?.('authored:') ?? []).filter((k) => k.startsWith('authored:')).map((k) => k.slice(9)).sort().filter((id) => id > (body.cursor as string));
      const page = ids.slice(0, 32);
      await this.sendApp(info.deviceId, 'history-page', { ids: page, next: ids.length > page.length ? page.at(-1) : null });
    } else if (topic === 'history-page') {
      if (!Array.isArray(body.ids) || body.ids.length > 32 || !body.ids.every((id) => typeof id === 'string' && /^[a-z0-9-]{1,100}$/.test(id)) || (body.next !== null && typeof body.next !== 'string')) return;
      const missing: string[] = [];
      for (const id of body.ids as string[]) if (!this.authoredSeen.has(id) && !await this.o.model.store.getMeta(`authored:${id}`)) missing.push(id);
      this.historyPending.set(info.conn, { ids: missing, next: body.next as string | null });
      this.historyChanged(); await this.requestHistoryNext(info);
    } else if (topic === 'history-want') {
      if (typeof body.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(body.id)) return;
      const operation = await readAuthoredOperation(this.o.model.store, body.id).catch(() => undefined);
      if (operation) await this.sendHistory(info.conn, operation);
    } else if (topic === 'history-part') {
      if (typeof body.id !== 'string' || typeof body.data !== 'string' || body.data.length > 180_000 || !Number.isSafeInteger(body.part) || !Number.isSafeInteger(body.total) || (body.total as number) < 1 || (body.total as number) > 768) return;
      const live = body.live === true;
      if (!live && this.historyPending.get(info.conn)?.ids[0] !== body.id) return;
      if (live && info.claims.role === 'viewer') return;
      if (!live) this.armHistoryWant(info, body.id);
      let incoming = this.historyParts.get(info.conn);
      if (body.part === 0) {
        incoming = { id: body.id, parts: [], total: body.total as number, size: 0, live, at: Date.now() };
        this.historyParts.set(info.conn, incoming);
      }
      if (!incoming || incoming.id !== body.id || body.part !== incoming.parts.length || body.total !== incoming.total || incoming.live !== live || Date.now() - incoming.at > 120_000) return;
      const part = fromB64u(body.data); incoming.parts.push(part); incoming.size += part.length;
      if (incoming.size > 96 * 1024 * 1024) { this.historyParts.delete(info.conn); if (!live) await this.skipHistory(info, incoming.id, 'record too large'); return; }
      if (incoming.parts.length !== incoming.total) return;
      this.historyParts.delete(info.conn);
      const bytes = new Uint8Array(incoming.size); let offset = 0;
      for (const part of incoming.parts) { bytes.set(part, offset); offset += part.length; }
      if (live) { await this.handleFrame(info.conn, MsgType.AUTHORED, bytes); return; }
      let checked: Awaited<ReturnType<typeof verifyOperation>>;
      try { checked = await verifyOperation(parseJson(bytes), this.o.projectId, this.o.trusted, { historical: true }); }
      catch (error) { await this.skipHistory(info, incoming.id, `verification failed: ${error instanceof Error ? error.message : String(error)}`); return; }
      if (this.conns.get(info.conn) !== info) return;
      if (checked.operation.id !== incoming.id) { await this.skipHistory(info, incoming.id, 'record identifier mismatch'); return; }
      if (!this.authoredSeen.has(incoming.id) && !await this.o.model.store.getMeta(`authored:${incoming.id}`)) {
        try {
          await storeAuthoredOperation(this.o.model.store, checked.operation);
          await this.o.model.store.putChangeSet(this.withPaths(projectAuthoredOperation(checked.operation, checked.claims)));
        } catch (error) { await this.skipHistory(info, incoming.id, `storage failed: ${error instanceof Error ? error.message : String(error)}`); return; }
        this.historyReceived++;
      }
      this.historyPending.get(info.conn)?.ids.shift();
      this.historyChanged(); await this.requestHistoryNext(info);
    }
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
    const newest = !m || c.ep > m.newest.ep || (c.ep === m.newest.ep && c.iat >= m.newest.iat) ? c : m.newest;
    this.deviceMarks.set(c.dev, { ep: Math.max(m?.ep ?? 0, c.ep), iat: Math.max(m?.iat ?? 0, c.iat), newest });
    if (newest.ep >= this.maxEpoch) this.releaseHeld(c.dev);
  }

  /**
   * Whether a signed operation may be applied now. One signed with a ticket from before the enforced epoch is judged by
   * its device's current ticket: applied if that device still edits, dropped if it was demoted. Until the device shows
   * its current ticket (within the refresh grace period) the operation is held, not dropped: a dropped keystroke would
   * leave every later one from that device waiting in Yjs for it.
   */
  private admitSigner(claims: TicketClaims, info: PeerInfo, payload: Uint8Array): boolean {
    if (claims.ep >= this.maxEpoch) return true;
    const current = this.deviceMarks.get(claims.dev)?.newest;
    if (current && current.ep >= this.maxEpoch) return current.uid === claims.uid && current.role !== 'viewer';
    if (this.now() - this.maxEpochSince <= (this.o.epochGraceMs ?? 60_000)) {
      const list = this.held.get(claims.dev) ?? [];
      if (list.length < 10_000) list.push({ info, payload });
      this.held.set(claims.dev, list);
    }
    return false;
  }

  /** The device showed a current ticket: its held operations go through admission again, in arrival order. */
  private releaseHeld(dev: string) {
    const list = this.held.get(dev);
    if (!list) return;
    this.held.delete(dev);
    for (const { info, payload } of list) if (this.conns.get(info.conn) === info) void this.onFrame(info.conn, MsgType.AUTHORED, payload);
  }

  /**
   * The control plane issued us a fresh ticket: after verifying it like any peer's, share it so peers see our current
   * role and epoch, and advance our own enforced epoch. Resolves false (sharing nothing) for an invalid ticket.
   */
  async refreshOwnTicket(ticket: string): Promise<boolean> {
    const claims = await this.verifyEvidence(ticket);
    if (!claims || claims.devE !== this.o.keys.edPub || claims.devX !== this.o.keys.xPub) return false;
    this.o.model.localAuthor = { uid: claims.uid, device: claims.dev, name: claims.uname };
    await this.o.model.store.setMeta('localAuthor', this.o.model.localAuthor);
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
    // Devices that never showed a current ticket within the grace period: their held operations are refused.
    if (now - this.maxEpochSince > grace) this.held.clear();
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
    this.closed = true;
    for (const g of [...this.authoredGroups.values()]) this.closeAuthoredGroup(g);
    clearInterval(this.policyTimer);
    for (const t of this.slotTimers) clearTimeout(t);
    if (this.nbrsTimer) clearTimeout(this.nbrsTimer);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.unsub();
    for (const c of [...this.conns.keys()]) c.close();
    this.awareness.destroy();
  }
}

export { LOCAL_ORIGIN };
export type { AppHandler, RawHandler };
