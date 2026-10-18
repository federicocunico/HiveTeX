import { fromB64u, sign, toB64u, verify, verifyTicket, type StoredDeviceKeys } from '@hivetex/crypto';
import type { TicketClaims, TrustedKey } from '@hivetex/protocol';
import type { PeerConnection } from './connection.js';
import { sha256Hex } from './model.js';
import type { Persistence } from './persistence.js';
import { isBytes } from './bytes.js';

/**
 * Signed operation envelope. v2 carries no preimage: each receiver derives what it needs from its own state. v1 (an
 * unreleased development format that also signed a full `before` state) is still verified and read, never written.
 */
export interface AuthoredOperation {
  v: 1 | 2;
  id: string;
  pid: string;
  docId: string;
  at: number;
  uid: string;
  device: string;
  source: 'editor' | 'folder' | 'undo' | 'import' | 'restore';
  dependencies: string[];
  hash: string;
  update: string;
  /** v1 only. */
  before?: string;
  ticket: string;
  signature: string;
}
const bytes = (op: Omit<AuthoredOperation, 'signature'>) => new TextEncoder().encode(JSON.stringify(op.v === 1
  ? ['hivetex/authored-operation/v1', op.id, op.pid, op.docId, op.at, op.uid, op.device, op.source, op.dependencies, op.hash, op.update, op.before, op.ticket]
  : ['hivetex/authored-operation/v2', op.id, op.pid, op.docId, op.at, op.uid, op.device, op.source, op.dependencies, op.hash, op.update, op.ticket]));
const ticketCache = new Map<string, TicketClaims>();
const publicKeys = new Map<string, Promise<CryptoKey>>();
async function operationSignature(key: string, message: Uint8Array, signature: Uint8Array) {
  try {
    if (!publicKeys.has(key)) {
      if (publicKeys.size >= 256) publicKeys.delete(publicKeys.keys().next().value!);
      publicKeys.set(key, crypto.subtle.importKey('raw', fromB64u(key) as BufferSource, { name: 'Ed25519' }, false, ['verify']));
    }
    return await crypto.subtle.verify({ name: 'Ed25519' }, await publicKeys.get(key)!, signature as BufferSource, message as BufferSource);
  } catch { return verify(key, message, signature); }
}

export class AuthoredOrigin {
  constructor(readonly operation: AuthoredOperation, readonly claims: TicketClaims, readonly forwarder: PeerConnection) {}
}

export async function signOperation(input: { pid: string; docId: string; update: Uint8Array; ticket: string; source: AuthoredOperation['source']; dependencies?: string[]; at?: number }, keys: StoredDeviceKeys): Promise<AuthoredOperation> {
  const claims = JSON.parse(new TextDecoder().decode(fromB64u(input.ticket.split('.')[1] ?? ''))) as TicketClaims;
  const op: Omit<AuthoredOperation, 'signature'> = {
    v: 2, id: crypto.randomUUID(), pid: input.pid, docId: input.docId, at: input.at ?? Date.now(), uid: claims.uid, device: claims.dev,
    source: input.source, dependencies: input.dependencies ?? [], hash: await sha256Hex(input.update), update: toB64u(input.update), ticket: input.ticket,
  };
  return { ...op, signature: toB64u(await sign(keys, bytes(op))) };
}

/** Historical verification proves provenance only. The caller separately admits live writes with current policy. */
export async function verifyOperation(value: unknown, pid: string, trusted: TrustedKey[], options: { historical?: boolean; now?: Date | undefined } = {}) {
  const op = value as AuthoredOperation;
  if (!op || (op.v !== 1 && op.v !== 2) || op.pid !== pid || typeof op.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(op.id) ||
    typeof op.docId !== 'string' || (op.docId !== 'root' && !/^f:[a-zA-Z0-9_-]+$/.test(op.docId)) ||
    !['editor', 'folder', 'undo', 'import', 'restore'].includes(op.source) || !Array.isArray(op.dependencies) || op.dependencies.length > 32 ||
    !op.dependencies.every((d) => typeof d === 'string' && /^[a-z0-9-]{1,100}$/.test(d)) || !Number.isFinite(op.at) ||
    typeof op.update !== 'string' || op.update.length > 44 * 1024 * 1024 || (op.v === 1 ? typeof op.before !== 'string' || op.before.length > 44 * 1024 * 1024 : op.before !== undefined) || typeof op.ticket !== 'string' || op.ticket.length > 8192) throw new Error('Unsupported operation envelope');
  const untrusted = JSON.parse(new TextDecoder().decode(fromB64u(op.ticket.split('.')[1] ?? ''))) as TicketClaims;
  const now = options.historical ? new Date(untrusted.iat * 1000 + 1000) : options.now;
  const cacheKey = JSON.stringify(trusted) + op.ticket;
  let claims = ticketCache.get(cacheKey);
  const at = (now ?? new Date()).getTime();
  if (!claims || at > claims.exp * 1000 + 30_000 || at < claims.iat * 1000 - 30_000) {
    claims = await verifyTicket(op.ticket, trusted, now ? { now } : {});
    if (ticketCache.size >= 256) ticketCache.delete(ticketCache.keys().next().value!);
    ticketCache.set(cacheKey, claims);
  }
  if (claims.pid !== pid || claims.uid !== op.uid || claims.dev !== op.device || claims.role === 'viewer' ||
    !(await operationSignature(claims.devE, bytes(op), fromB64u(op.signature)))) throw new Error('Invalid operation signature or author');
  const update = fromB64u(op.update);
  if (await sha256Hex(update) !== op.hash) throw new Error('Operation content hash mismatch');
  return { operation: op, claims, update };
}

/** Bounded metadata values work identically over IndexedDB, SQLite and the editor's IPC bridge. */
const storing = new WeakMap<Persistence, Promise<void>>();
export async function storeAuthoredOperation(store: Persistence, operation: AuthoredOperation) {
  const next = (storing.get(store) ?? Promise.resolve()).catch(() => {}).then(() => writeAuthoredOperation(store, operation));
  storing.set(store, next);
  try { await next; } finally { if (storing.get(store) === next) storing.delete(store); }
}
async function writeAuthoredOperation(store: Persistence, operation: AuthoredOperation) {
  const existing = await readAuthoredOperation(store, operation.id);
  if (existing) {
    const a = bytes(existing), b = bytes(operation);
    if (existing.signature !== operation.signature || a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error('Operation ID already belongs to different immutable evidence');
    return;
  }
  const encoded = new TextEncoder().encode(JSON.stringify(operation));
  const chunkSize = 256 * 1024, chunks = Math.ceil(encoded.length / chunkSize);
  for (let n = 0; n < chunks; n++) await store.setMeta(`authored-bytes:${operation.id}:${n}`, encoded.slice(n * chunkSize, (n + 1) * chunkSize));
  await store.setMeta(`authored:${operation.id}`, { v: 1, chunks });
}

export async function readAuthoredOperation(store: Persistence, id: string): Promise<AuthoredOperation | undefined> {
  const descriptor = await store.getMeta(`authored:${id}`) as { v?: number; chunks?: number } | undefined;
  if (!descriptor) return undefined;
  if (descriptor.v !== 1 || !Number.isSafeInteger(descriptor.chunks) || descriptor.chunks! < 1 || descriptor.chunks! > 512) throw new Error('Unsupported authored operation storage');
  const parts: Uint8Array[] = [];
  for (let n = 0; n < descriptor.chunks!; n++) {
    const part = await store.getMeta(`authored-bytes:${id}:${n}`);
    if (!isBytes(part)) throw new Error('Incomplete authored operation');
    parts.push(part);
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const op = JSON.parse(new TextDecoder().decode(bytes)) as AuthoredOperation;
  if (op.id !== id) throw new Error('Authored operation identifier mismatch');
  return op;
}
