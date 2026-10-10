/**
 * Wire protocol shared by every client. Frame = [type: u8][payload].
 * Doc frames (STEP1/STEP2/UPDATE) payload = [docIdLen: u16 BE][docId utf8][data].
 * The high bit of the type byte (0x80) marks a deflate-raw compressed payload.
 */
export const MsgType = {
  /** Handshake step 1: JSON {ticket, nonce}. */
  HELLO: 0x01,
  /** Handshake step 2: JSON {sig}. */
  AUTH: 0x02,
  /** Yjs sync step 1: state vector of a document. Also signals interest in that document. */
  STEP1: 0x10,
  /** Yjs sync step 2: update containing what the requester is missing. */
  STEP2: 0x11,
  /** Incremental Yjs update. */
  UPDATE: 0x12,
  /** y-protocols awareness update (presence, cursors). */
  AWARENESS: 0x13,
  /** JSON {epoch}: highest membership epoch seen by the sender. */
  EPOCH: 0x20,
  /** JSON {ticket}: refreshed membership ticket. */
  TICKET: 0x21,
  /** JSON {hashes: string[]}: blobs the sender holds. */
  BLOB_HAVE: 0x30,
  /** JSON {hash, from, to}: request chunks [from, to) of a blob. */
  BLOB_WANT: 0x31,
  /** [hashLen u8][hash][index u32][total u32][bytes]: one blob chunk. */
  BLOB_CHUNK: 0x32,
  /** JSON {hash}: sender does not hold the requested blob. */
  BLOB_NONE: 0x33,
  /** JSON {devices: [...]}: peer exchange for mesh introductions. */
  PEERS: 0x40,
  /** JSON {topic, body}: application-level control messages (compile election, etc.). */
  APP: 0x60,
} as const;
export type MsgTypeName = keyof typeof MsgType;
export type MsgTypeValue = (typeof MsgType)[MsgTypeName];

export const COMPRESSED_FLAG = 0x80;
export const COMPRESS_THRESHOLD = 1024;
export const FRAGMENT_SIZE = 16 * 1024;
export const BUFFER_HIGH_WATER = 1024 * 1024;
export const BLOB_CHUNK_SIZE = 16 * 1024 - 64;

/** Message types a `viewer` connection may send. Everything else from a viewer is dropped. */
export const VIEWER_ALLOWED: ReadonlySet<number> = new Set([
  MsgType.HELLO,
  MsgType.AUTH,
  MsgType.STEP1,
  MsgType.AWARENESS,
  MsgType.EPOCH,
  MsgType.TICKET,
  MsgType.BLOB_WANT,
  MsgType.BLOB_NONE,
  MsgType.PEERS,
  MsgType.APP,
]);

export const HANDSHAKE_DOMAIN = 'hivetex/v1';
export const ROOT_DOC_ID = 'root';
export const fileDocId = (fileId: string) => `f:${fileId}`;

/** Domain separation for the signaling relay's key-possession proof (device signs the server's nonce). */
export const SIGNAL_DOMAIN = 'hivetex/signal/v1';

/** Bytes a device signs to prove it holds the key named in its ticket when joining the signaling relay. */
export function signalAuthMessage(pid: string, dev: string, nonce: string): string {
  return [SIGNAL_DOMAIN, pid, dev, nonce].join('\0');
}

/** Largest blob (binary file) peers will transfer, in bytes. Matches the import size limit. */
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;
