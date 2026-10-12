import { x25519 } from "@noble/curves/ed25519.js";
import type { TicketClaims, TrustedKey } from "@hivetex/protocol";
import { fromB64u, sign, toB64u, verify, verifyTicket, type StoredDeviceKeys } from "./index.js";

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const bs = (b: Uint8Array) => b as unknown as BufferSource;
const bytes = (v: unknown) => enc.encode(JSON.stringify(v));
const DOMAIN = "hivetex/relay/v1";
const random = () => toB64u(crypto.getRandomValues(new Uint8Array(32)));
function fixed(s: unknown, length: number): Uint8Array {
  if (typeof s !== "string" || s.length > 128 || !/^[A-Za-z0-9_-]+$/.test(s))
    throw new Error("invalid relay encoding");
  const b = fromB64u(s);
  if (b.length !== length || toB64u(b) !== s) throw new Error("invalid relay encoding");
  return b;
}

export type RelayRole = "initiator" | "responder";
export interface RelayHello {
  v: 1;
  role: RelayRole;
  ticket: string;
  ephemeral: string;
  challenge: string;
  generation: string;
}
export interface RelayHandshakeOptions {
  projectId: string;
  peerDeviceId: string;
  ticket: string;
  keys: StoredDeviceKeys;
  trusted: TrustedKey[];
  role: RelayRole;
  now?: () => number;
}
interface Material {
  send: CryptoKey;
  receive: CryptoKey;
  sendConfirm: CryptoKey;
  receiveConfirm: CryptoKey;
  sendPrefix: Uint8Array;
  receivePrefix: Uint8Array;
}

/** Bounded, one-shot authenticated ephemeral key exchange. No application key is exposed before confirmation. */
export class RelayHandshake {
  readonly hello: Readonly<RelayHello>;
  private secret: Uint8Array | null;
  private material: Material | null = null;
  private transcript: Uint8Array | null = null;
  private hash = "";
  private peer: TicketClaims | null = null;
  private state: "hello" | "proof" | "confirm" | "done" | "closed" = "hello";
  private busy = false;
  private deadline: number;
  private timer: ReturnType<typeof setTimeout>;
  private constructor(
    private o: RelayHandshakeOptions,
    private local: TicketClaims,
  ) {
    this.secret = x25519.utils.randomSecretKey();
    this.hello = Object.freeze({
      v: 1,
      role: o.role,
      ticket: o.ticket,
      ephemeral: toB64u(x25519.getPublicKey(this.secret)),
      challenge: random(),
      generation: random(),
    });
    this.deadline = this.now() + 10_000;
    this.timer = setTimeout(() => this.close(), 10_000);
  }
  static async create(o: RelayHandshakeOptions): Promise<RelayHandshake> {
    if (o.role !== "initiator" && o.role !== "responder") throw new Error("invalid relay role");
    const local = await verifyTicket(o.ticket, o.trusted, {
      now: new Date((o.now ?? Date.now)()),
      clockToleranceSec: 0,
    });
    if (
      local.pid !== o.projectId ||
      local.devE !== o.keys.edPub ||
      local.devX !== o.keys.xPub ||
      local.dev === o.peerDeviceId
    )
      throw new Error("invalid local relay identity");
    return new RelayHandshake({ ...o }, local);
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }
  private live() {
    if (
      this.state === "closed" ||
      this.now() >= this.deadline ||
      this.local.exp * 1000 <= this.now() ||
      (this.peer && this.peer.exp * 1000 <= this.now())
    )
      throw new Error("relay handshake expired or closed");
  }
  private async step<T>(expected: typeof this.state, run: () => Promise<T>): Promise<T> {
    try {
      this.live();
      if (this.busy || this.state !== expected)
        throw new Error("unexpected relay handshake message");
      this.busy = true;
      const result = await run();
      this.live();
      return result;
    } catch (e) {
      this.close();
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async acceptHello(input: RelayHello): Promise<string> {
    return this.step("hello", async () => {
      // Snapshot untrusted input before any await; canonical transcripts never serialize caller-owned objects.
      const h = {
        v: input.v,
        role: input.role,
        ticket: input.ticket,
        ephemeral: input.ephemeral,
        challenge: input.challenge,
        generation: input.generation,
      };
      if (
        h.v !== 1 ||
        h.role !== (this.o.role === "initiator" ? "responder" : "initiator") ||
        typeof h.ticket !== "string" ||
        h.ticket.length > 8192
      )
        throw new Error("invalid relay hello");
      const remoteKey = fixed(h.ephemeral, 32);
      fixed(h.challenge, 32);
      fixed(h.generation, 32);
      const peer = await verifyTicket(h.ticket, this.o.trusted, {
        now: new Date(this.now()),
        clockToleranceSec: 0,
      });
      if (
        peer.pid !== this.o.projectId ||
        peer.dev !== this.o.peerDeviceId ||
        peer.dev === this.local.dev
      )
        throw new Error("wrong relay peer or project");
      this.peer = peer;
      const entry = (c: TicketClaims, hello: Readonly<RelayHello>) => [
        hello.role,
        c.uid,
        c.dev,
        c.devE,
        c.devX,
        hello.ticket,
        hello.ephemeral,
        hello.challenge,
        hello.generation,
      ];
      const local = entry(this.local, this.hello),
        remote = entry(peer, h);
      this.transcript = bytes([
        DOMAIN,
        this.o.projectId,
        ...(this.o.role === "initiator" ? [local, remote] : [remote, local]),
      ]);
      const digest = new Uint8Array(await subtle.digest("SHA-256", bs(this.transcript)));
      this.hash = toB64u(digest);
      this.live();
      if (!this.secret) throw new Error("relay key destroyed");
      let shared: Uint8Array | undefined;
      try {
        shared = x25519.getSharedSecret(this.secret, remoteKey);
        if (shared.every((b) => b === 0)) throw new Error("invalid relay shared secret");
        const ikm = await subtle.importKey("raw", bs(shared), "HKDF", false, [
          "deriveKey",
          "deriveBits",
        ]);
        const params = (label: string) => ({
          name: "HKDF",
          hash: "SHA-256",
          salt: bs(digest),
          info: bs(bytes([DOMAIN, label, this.hash])),
        });
        const data = (direction: string, usage: KeyUsage) =>
          subtle.deriveKey(
            params(direction + "/data"),
            ikm,
            { name: "AES-GCM", length: 256 },
            false,
            [usage],
          );
        const confirm = (direction: string, usage: KeyUsage) =>
          subtle.deriveKey(
            params(direction + "/confirmation"),
            ikm,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            [usage],
          );
        const prefix = async (direction: string) =>
          new Uint8Array(await subtle.deriveBits(params(direction + "/nonce"), ikm, 32));
        const sendDir = this.o.role === "initiator" ? "i-to-r" : "r-to-i",
          receiveDir = this.o.role === "initiator" ? "r-to-i" : "i-to-r";
        const [send, receive, sendConfirm, receiveConfirm, sendPrefix, receivePrefix] =
          await Promise.all([
            data(sendDir, "encrypt"),
            data(receiveDir, "decrypt"),
            confirm(sendDir, "sign"),
            confirm(receiveDir, "verify"),
            prefix(sendDir),
            prefix(receiveDir),
          ]);
        this.live();
        this.material = { send, receive, sendConfirm, receiveConfirm, sendPrefix, receivePrefix };
      } finally {
        shared?.fill(0);
        this.secret?.fill(0);
        this.secret = null;
      }
      const proof = await sign(this.o.keys, bytes([DOMAIN, "signature", this.hash, this.o.role]));
      this.state = "proof";
      return toB64u(proof);
    });
  }
  async acceptProof(proof: string): Promise<string> {
    return this.step("proof", async () => {
      if (!this.peer || !this.material) throw new Error("missing relay hello");
      const remoteRole = this.o.role === "initiator" ? "responder" : "initiator";
      if (
        !(await verify(
          this.peer.devE,
          bytes([DOMAIN, "signature", this.hash, remoteRole]),
          fixed(proof, 64),
        ))
      )
        throw new Error("invalid relay possession proof");
      const confirm = await subtle.sign(
        "HMAC",
        this.material.sendConfirm,
        bs(bytes([DOMAIN, "confirmed", this.hash, this.o.role])),
      );
      this.state = "confirm";
      return toB64u(new Uint8Array(confirm));
    });
  }
  async acceptConfirmation(confirmation: string): Promise<RelaySession> {
    return this.step("confirm", async () => {
      if (!this.material || !this.peer) throw new Error("missing relay keys");
      const role = this.o.role === "initiator" ? "responder" : "initiator";
      if (
        !(await subtle.verify(
          "HMAC",
          this.material.receiveConfirm,
          bs(fixed(confirmation, 32)),
          bs(bytes([DOMAIN, "confirmed", this.hash, role])),
        ))
      )
        throw new Error("invalid relay key confirmation");
      this.live();
      const session = new RelaySession(
        this.material,
        this.hash,
        this.o.role,
        this.o.projectId,
        this.local,
        this.peer,
        this.o.now ?? Date.now,
      );
      this.material = null;
      this.state = "done";
      clearTimeout(this.timer);
      this.transcript = null;
      return session;
    });
  }
  close() {
    clearTimeout(this.timer);
    this.state = "closed";
    this.secret?.fill(0);
    this.secret = null;
    this.material = null;
    this.transcript = null;
  }
}

export interface RelayFrameContext {
  kind: "data" | "ack" | "control";
  channel: "sync" | "bulk";
  message: number;
  fragment: number;
  fragments: number;
}
export interface RelayEnvelope extends RelayFrameContext {
  v: 1;
  session: string;
  counter: number;
  ciphertext: string;
}
const MAX_FRAGMENT = 16 * 1024;
const REPLAY_WINDOW = 1024;
const MAX_COUNTER = 0xffff_ffff;
function context(c: RelayFrameContext): RelayFrameContext {
  if (
    !["data", "ack", "control"].includes(c.kind) ||
    !["sync", "bulk"].includes(c.channel) ||
    !Number.isSafeInteger(c.message) ||
    c.message < 0 ||
    !Number.isSafeInteger(c.fragments) ||
    c.fragments < 1 ||
    c.fragments > 4096 ||
    !Number.isSafeInteger(c.fragment) ||
    c.fragment < 0 ||
    c.fragment >= c.fragments
  )
    throw new Error("invalid relay frame context");
  return {
    kind: c.kind,
    channel: c.channel,
    message: c.message,
    fragment: c.fragment,
    fragments: c.fragments,
  };
}

/** Cipher state belongs to exactly one confirmed generation; repeated ciphertext is acknowledged but never reapplied. */
export class RelaySession {
  private counter = 0;
  private pendingBytes = 0;
  private pendingFrames = 0;
  private highest = -1;
  private received = new Set<number>();
  private inbound: Promise<unknown> = Promise.resolve();
  readonly binding: {
    readonly kind: "relay";
    readonly transcriptHash: string;
    readonly localRole: RelayRole;
  };
  constructor(
    material: Material | null,
    readonly id: string,
    role: RelayRole,
    private project: string,
    readonly local: TicketClaims,
    readonly peer: TicketClaims,
    private now: () => number,
  ) {
    this.material = material
      ? {
          send: material.send,
          receive: material.receive,
          sendPrefix: material.sendPrefix,
          receivePrefix: material.receivePrefix,
        }
      : null;
    this.local = Object.freeze({ ...local });
    this.peer = Object.freeze({ ...peer });
    this.binding = Object.freeze({ kind: "relay", transcriptHash: id, localRole: role });
  }
  private material: Pick<Material, "send" | "receive" | "sendPrefix" | "receivePrefix"> | null;
  private live() {
    if (!this.material || Math.min(this.local.exp, this.peer.exp) * 1000 <= this.now()) {
      this.close();
      throw new Error("relay session expired or closed");
    }
    return this.material;
  }
  private nonce(prefix: Uint8Array, counter: number) {
    const nonce = new Uint8Array(12);
    nonce.set(prefix);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
    return nonce;
  }
  private aad(c: RelayFrameContext, counter: number, incoming: boolean) {
    return bytes([
      DOMAIN,
      "frame",
      this.project,
      this.id,
      incoming ? this.peer.dev : this.local.dev,
      incoming ? this.local.dev : this.peer.dev,
      c.kind,
      c.channel,
      c.message,
      c.fragment,
      c.fragments,
      counter,
    ]);
  }
  async seal(c: RelayFrameContext, plaintext: Uint8Array): Promise<RelayEnvelope> {
    const m = this.live(),
      ctx = context(c);
    if (plaintext.length > MAX_FRAGMENT) throw new Error("relay fragment too large");
    if (this.counter >= MAX_COUNTER) {
      this.close();
      throw new Error("relay counter exhausted: rekey required");
    }
    const counter = this.counter++;
    const ciphertext = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: bs(this.nonce(m.sendPrefix, counter)),
        additionalData: bs(this.aad(ctx, counter, false)),
      },
      m.send,
      bs(plaintext.slice()),
    );
    this.live();
    return {
      ...ctx,
      v: 1,
      session: this.id,
      counter,
      ciphertext: toB64u(new Uint8Array(ciphertext)),
    };
  }
  open(
    input: RelayEnvelope,
  ): Promise<{ context: RelayFrameContext; plaintext: Uint8Array; duplicate: boolean }> {
    const size = typeof input.ciphertext === "string" ? input.ciphertext.length : 0;
    if (
      !size ||
      size > Math.ceil(((MAX_FRAGMENT + 16) * 4) / 3) ||
      this.pendingBytes + size > 4 * 1024 * 1024 ||
      this.pendingFrames >= 256
    )
      return Promise.reject(new Error("relay decrypt queue exceeded"));
    const envelope = { ...input };
    this.pendingBytes += size;
    this.pendingFrames++;
    const run = this.inbound.then(async () => {
      const m = this.live(),
        ctx = context(envelope),
        counter = envelope.counter;
      if (
        envelope.v !== 1 ||
        envelope.session !== this.id ||
        !Number.isSafeInteger(counter) ||
        counter < 0 ||
        counter >= MAX_COUNTER ||
        counter <= this.highest - REPLAY_WINDOW
      )
        throw new Error("stale or invalid relay envelope");
      if (
        typeof envelope.ciphertext !== "string" ||
        envelope.ciphertext.length > Math.ceil(((MAX_FRAGMENT + 16) * 4) / 3)
      )
        throw new Error("relay ciphertext too large");
      const ciphertext = fromB64u(envelope.ciphertext);
      if (
        ciphertext.length < 16 ||
        ciphertext.length > MAX_FRAGMENT + 16 ||
        toB64u(ciphertext) !== envelope.ciphertext
      )
        throw new Error("invalid relay ciphertext");
      const plaintext = new Uint8Array(
        await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bs(this.nonce(m.receivePrefix, counter)),
            additionalData: bs(this.aad(ctx, counter, true)),
          },
          m.receive,
          bs(ciphertext),
        ),
      );
      this.live();
      const duplicate = this.received.has(counter);
      this.highest = Math.max(this.highest, counter);
      this.received.add(counter);
      for (const n of this.received) if (n <= this.highest - REPLAY_WINDOW) this.received.delete(n);
      return { context: ctx, plaintext: duplicate ? new Uint8Array() : plaintext, duplicate };
    });
    const result = run.finally(() => {
      this.pendingBytes -= size;
      this.pendingFrames--;
    });
    this.inbound = result.catch(() => {});
    return result;
  }
  close() {
    this.material = null;
    this.received.clear();
  }
}
