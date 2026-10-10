import {
  type StoredDeviceKeys,
  fromB64u,
  sign,
  toB64u,
  verify,
  verifyTicket,
} from '@hivetex/crypto';
import {
  HANDSHAKE_DOMAIN,
  MsgType,
  type Role,
  type TicketClaims,
  type TrustedKey,
  VIEWER_ALLOWED,
} from '@hivetex/protocol';
import { decodeFrame, encodeFrame, jsonBytes, parseJson, utf8 } from './frames.js';
import type { ChannelName, PeerTransport } from './transport.js';

export class AuthError extends Error {}

export interface ConnectionOptions {
  transport: PeerTransport;
  projectId: string;
  keys: StoredDeviceKeys;
  trusted: TrustedKey[];
  getTicket: () => string;
  now?: () => Date;
  /** How long after open the peer has to complete the handshake. */
  handshakeTimeoutMs?: number;
}

export type FrameHandler = (conn: PeerConnection, type: number, payload: Uint8Array) => void;

const channelFor = (type: number): ChannelName =>
  type === MsgType.BLOB_CHUNK || type === MsgType.BLOB_HAVE || type === MsgType.BLOB_WANT || type === MsgType.BLOB_NONE
    ? 'bulk'
    : 'sync';

function transcript(pid: string, signerLocalFp: string, signerRemoteFp: string, signerNonce: string, verifierNonce: string) {
  // The signature covers BOTH DTLS fingerprints: an in-the-middle that relays SDP presents
  // different fingerprints to each side and so cannot produce a matching signature.
  return utf8([HANDSHAKE_DOMAIN, pid, signerLocalFp, signerRemoteFp, signerNonce, verifierNonce].join('\0'));
}

/** One authenticated connection to a peer device. Enforces the role filter on inbound frames. */
export class PeerConnection {
  claims: TicketClaims | null = null;
  /** The raw JWS of the peer's latest verified ticket (shared with others for introductions). */
  ticketRaw = '';
  private helloTicketRaw = '';
  readonly ready: Promise<TicketClaims>;
  closed = false;
  /** Ordered inbound processing: decompression is async and must not reorder frames. */
  private inbound: Promise<void> = Promise.resolve();
  private myNonce = toB64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  private peerNonce: string | null = null;
  private peerHelloClaims: TicketClaims | null = null;
  private peerAuthSig: string | null = null;
  private authenticated = false;
  private handler: FrameHandler = () => {};
  private closeHandlers: Array<() => void> = [];
  private resolveReady!: (c: TicketClaims) => void;
  private rejectReady!: (e: Error) => void;
  droppedFromViewer = 0;
  /** Wall-clock time of the last frame received from the peer (liveness). */
  lastRx = Date.now();
  /** Epoch bookkeeping used by the mesh's revocation policy. */
  lastTicketAt: number;

  constructor(private o: ConnectionOptions) {
    this.lastTicketAt = (o.now ?? (() => new Date()))().getTime();
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
    o.transport.onMessage((_ch, data) => this.receive(data));
    o.transport.onClose(() => this.handleClose());
    const timeout = setTimeout(() => this.fail(new AuthError('handshake timeout')), o.handshakeTimeoutMs ?? 10_000);
    this.ready.finally(() => clearTimeout(timeout)).catch(() => {});
    void this.sendRaw(MsgType.HELLO, jsonBytes({ ticket: o.getTicket(), nonce: this.myNonce }), true).catch(() => {});
  }

  get role(): Role {
    return this.claims?.role ?? 'viewer';
  }
  get peerDeviceId() {
    return this.claims?.dev ?? '';
  }

  onFrame(h: FrameHandler) {
    this.handler = h;
  }
  onClose(h: () => void) {
    this.closeHandlers.push(h);
  }

  private fail(e: Error) {
    this.rejectReady(e);
    this.close();
  }

  close() {
    this.o.transport.close();
    // A dead peer never acknowledges the channel close, so treat the connection as gone right away.
    this.handleClose();
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(new AuthError('closed'));
    for (const h of this.closeHandlers) h();
  }

  /** Sends an application frame. Rejects before authentication completes. */
  async send(type: number, payload: Uint8Array, opts: { noCompress?: boolean } = {}) {
    if (!this.authenticated) throw new Error('not authenticated');
    await this.sendRaw(type, payload, opts.noCompress);
  }

  private async sendRaw(type: number, payload: Uint8Array, noCompress = false) {
    if (this.closed) return;
    await this.o.transport.send(channelFor(type), await encodeFrame(type, payload, noCompress));
  }

  private receive(data: Uint8Array) {
    this.lastRx = Date.now();
    this.inbound = this.inbound
      .then(async () => {
        if (this.closed) return;
        const { type, payload } = await decodeFrame(data);
        await this.dispatch(type, payload);
      })
      .catch((e) => {
        if (!this.authenticated) this.fail(e instanceof Error ? e : new AuthError('bad frame'));
        else this.close();
      });
  }

  private async dispatch(type: number, payload: Uint8Array) {
    if (!this.authenticated) {
      if (type === MsgType.HELLO) return this.onHello(payload);
      if (type === MsgType.AUTH) return this.onAuth(payload);
      throw new AuthError('unexpected frame before authentication');
    }
    if (type === MsgType.TICKET) return this.onTicketRefresh(payload);
    if (this.role === 'viewer' && !VIEWER_ALLOWED.has(type)) {
      this.droppedFromViewer++;
      return;
    }
    this.handler(this, type, payload);
  }

  private async onHello(payload: Uint8Array) {
    if (this.peerHelloClaims) throw new AuthError('duplicate hello');
    const { ticket, nonce } = parseJson<{ ticket: string; nonce: string }>(payload);
    const claims = await verifyTicket(ticket, this.o.trusted, this.o.now ? { now: this.o.now() } : {});
    if (claims.pid !== this.o.projectId) throw new AuthError('ticket for another project');
    this.peerHelloClaims = claims;
    this.helloTicketRaw = ticket;
    this.peerNonce = nonce;
    const sig = await sign(
      this.o.keys,
      transcript(this.o.projectId, this.o.transport.localFingerprint, this.o.transport.remoteFingerprint, this.myNonce, nonce),
    );
    await this.sendRaw(MsgType.AUTH, jsonBytes({ sig: toB64u(sig) }), true);
    await this.tryFinish();
  }

  private async onAuth(payload: Uint8Array) {
    this.peerAuthSig = parseJson<{ sig: string }>(payload).sig;
    await this.tryFinish();
  }

  private async tryFinish() {
    if (this.authenticated || !this.peerHelloClaims || !this.peerAuthSig || !this.peerNonce) return;
    // From the peer's perspective: its local fp is what we see as remote, and vice versa.
    const msg = transcript(
      this.o.projectId,
      this.o.transport.remoteFingerprint,
      this.o.transport.localFingerprint,
      this.peerNonce,
      this.myNonce,
    );
    const ok = await verify(this.peerHelloClaims.devE, msg, fromB64u(this.peerAuthSig));
    if (!ok) throw new AuthError('peer failed key-possession proof');
    this.claims = this.peerHelloClaims;
    this.ticketRaw = this.helloTicketRaw;
    this.authenticated = true;
    this.resolveReady(this.claims);
  }

  /** Accepts a refreshed ticket for the SAME user/device/project; updates role and epoch. */
  private async onTicketRefresh(payload: Uint8Array) {
    const { ticket } = parseJson<{ ticket: string }>(payload);
    const c = await verifyTicket(ticket, this.o.trusted, this.o.now ? { now: this.o.now() } : {});
    const cur = this.claims;
    if (!cur || c.pid !== cur.pid || c.uid !== cur.uid || c.dev !== cur.dev || c.devE !== cur.devE) {
      throw new AuthError('ticket refresh for a different identity');
    }
    // Never go back in time: an older (still unexpired) ticket could restore a role the owner has since lowered.
    if (c.ep < cur.ep || c.iat < cur.iat) throw new AuthError('ticket refresh older than the current ticket');
    this.claims = c;
    this.ticketRaw = ticket;
    this.lastTicketAt = (this.o.now ?? (() => new Date()))().getTime();
    this.refreshHandler?.(this, c);
  }
  private refreshHandler: ((conn: PeerConnection, c: TicketClaims) => void) | null = null;
  onTicketRefreshed(h: (conn: PeerConnection, c: TicketClaims) => void) {
    this.refreshHandler = h;
  }
}

